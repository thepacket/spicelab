/*
 * libngspice -> JavaScript shim.
 *
 * Turns ngspice's callback-based C API into something the SimEngine contract in
 * src/worker/engines.js can be implemented against. Deliberately small: it does
 * no numerics, no netlist manipulation and no policy. Anything that could live
 * in JS does.
 *
 * Two things here are load-bearing.
 *
 * 1. `ngw_row` is called from INSIDE ngspice's solver loop, synchronously, once
 *    per accepted timepoint. The JS it calls is therefore also synchronous, and
 *    if that JS blocks, ngspice blocks. On a worker thread that is legal and is
 *    exactly how back-pressure is applied — see RingWriter.waitForSpace. This
 *    is the capability a subprocess-based frontend cannot have, and it is why
 *    linking the library was worth the trouble.
 *
 * 2. `ngw_exit` swallows ngspice's exit paths. A library embedded in a wasm
 *    runtime must never tear the runtime down; the spike showed ngspice
 *    normally reports errors without reaching here, but the guard has to exist
 *    for the paths that do.
 *
 * Built WITHOUT XSPICE, OSDI, OpenMP and pthreads. `bg_run` must never be
 * called: it is the only path that needs threads. See docs/ngspice-wasm-build.md.
 */
#include <emscripten.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sharedspice.h"

/* Row staging. ngspice hands us a struct-of-pointers; JS wants a flat f64 run
 * it can copy straight into the ring, so it is packed here. */
#define MAX_VECS 4096
static double  g_row[2 * MAX_VECS + 1];
static int     g_nvec = 0;
/**
 * Index of the INDEPENDENT variable (time, frequency, or a swept source).
 *
 * Found structurally, from `vecinfo.pdvecscale`, rather than by matching the
 * name "time". The first version of this matched by name and therefore left
 * `frequency` sitting in an ordinary column with slot 0 empty, so every AC row
 * had its x axis in the wrong place.
 */
static int     g_scale_idx = -1;
/** Whether this plot carries complex data, i.e. whether rows are re/im pairs. */
static bool    g_complex = false;
/**
 * Whether this plot HAS an independent variable at all.
 *
 * An operating point does not, and the pointer shape gives no hint: for `op`
 * ngspice points every vector's `pdvecscale` at the LAST ORDINARY SIGNAL, which
 * is structurally indistinguishable from `tran` pointing them all at `time`.
 * Trusting the pointers alone therefore silently DROPS a node from every op —
 * `in` vanished from a divider, and the missing column shifted the stride so a
 * later transient could not attach to the ring at all.
 *
 * The plot type is the only thing that distinguishes them: "op1" vs "tran1",
 * "ac1", "dc1".
 */
static bool    g_has_scale = false;

/* ---- JS side ------------------------------------------------------------ */

/* Row ready. JS reads g_row via HEAPF64 and may BLOCK to apply back-pressure. */
EM_JS(void, js_row, (double *ptr, int n), {
  Module.onRow && Module.onRow(ptr >> 3, n);
});

EM_JS(void, js_log, (const char *s, int is_err), {
  Module.onLog && Module.onLog(UTF8ToString(s), !!is_err);
});

/*
 * Vector names, newline-separated, in the order `js_row` will supply them, and
 * whether the values are complex. The caller needs both BEFORE the first row to
 * size a ring: a complex plot has stride 1 + 2n where a real one has 1 + n.
 */
EM_JS(void, js_vectors, (const char *s, int complex), {
  Module.onVectors && Module.onVectors(UTF8ToString(s), !!complex);
});

/* ---- ngspice callbacks -------------------------------------------------- */

static int cb_char(char *what, int id, void *user) {
  (void)id; (void)user;
  int is_err = (strncmp(what, "stderr", 6) == 0);
  js_log(what, is_err);
  return 0;
}

static int cb_stat(char *what, int id, void *user) {
  (void)what; (void)id; (void)user;
  return 0;
}

static int cb_exit(int status, NG_BOOL immediate, NG_BOOL quit, int id, void *u) {
  (void)immediate; (void)quit; (void)id; (void)u;
  char buf[96];
  snprintf(buf, sizeof buf, "stderr ngspice requested exit (status %d)", status);
  js_log(buf, 1);
  return status;                 /* return, never exit() */
}

/*
 * One accepted timepoint.
 *
 * Packed as [time, v0, v1, ...] to match the ring layout the Rust engine
 * already writes, so both engines produce the same row format and the
 * consumer, the probe system and the renderer need no knowledge of which
 * engine ran.
 */
static int cb_data(pvecvaluesall v, int count, int id, void *user) {
  (void)count; (void)id; (void)user;
  int n = v->veccount;
  if (n > MAX_VECS - 1) n = MAX_VECS - 1;

  int out = 1;                            /* slot 0 is the independent variable */
  g_row[0] = 0.0;
  for (int i = 0; i < n; i++) {
    pvecvalues p = v->vecsa[i];
    /* `is_scale` is authoritative and cheaper than trusting the index found at
     * init; use it when present and fall back to that index otherwise. */
    if (g_has_scale && (p->is_scale || i == g_scale_idx)) {
      g_row[0] = p->creal;
      continue;
    }
    g_row[out++] = p->creal;
    /* An AC plot must carry the imaginary part. Dropping it leaves the REAL
     * part masquerading as a magnitude — which still rolls off, still looks
     * like a filter response, and is wrong everywhere except DC. */
    if (g_complex) g_row[out++] = p->cimag;
  }
  js_row(g_row, out);
  return 0;
}

static int cb_init(pvecinfoall v, int id, void *user) {
  (void)id; (void)user;
  static char names[65536];
  names[0] = '\0';
  g_nvec = v->veccount;
  g_scale_idx = -1;
  g_complex = false;
  /* No independent variable in an operating point. See g_has_scale. */
  g_has_scale = !(v->type && strncmp(v->type, "op", 2) == 0);

  /* Identify the scale structurally: every dependent vector points at it
   * through `pdvecscale`, so the scale is the one whose own `pdvec` is that
   * target. Name matching cannot work — the independent variable is `time` for
   * tran, `frequency` for ac, and the swept source's name for dc. */
  void *scale = NULL;
  for (int i = 0; i < v->veccount; i++) {
    if (v->vecs[i]->pdvecscale) { scale = v->vecs[i]->pdvecscale; break; }
  }
  if (scale && g_has_scale) {
    for (int i = 0; i < v->veccount; i++) {
      if (v->vecs[i]->pdvec == scale) { g_scale_idx = i; break; }
    }
  }

  size_t used = 0;
  for (int i = 0; i < v->veccount; i++) {
    if (i == g_scale_idx) continue;
    if (!v->vecs[i]->is_real) g_complex = true;
    const char *nm = v->vecs[i]->vecname;
    size_t len = strlen(nm);
    if (used + len + 2 >= sizeof names) break;
    if (used) names[used++] = '\n';
    memcpy(names + used, nm, len);
    used += len;
    names[used] = '\0';
  }
  js_vectors(names, g_complex ? 1 : 0);
  return 0;
}

static int cb_bg(NG_BOOL running, int id, void *user) {
  (void)running; (void)id; (void)user;
  return 0;
}

/* ---- exported API ------------------------------------------------------- */

EMSCRIPTEN_KEEPALIVE
int ngw_init(void) {
  return ngSpice_Init(cb_char, cb_stat, cb_exit, cb_data, cb_init, cb_bg, NULL);
}

/*
 * Load a netlist given as one string.
 *
 * Split here rather than in JS because ngSpice_Circ wants a NULL-terminated
 * array of mutable char*, and marshalling that from JS means allocating a
 * pointer table by hand for no benefit.
 */
EMSCRIPTEN_KEEPALIVE
int ngw_load(const char *netlist) {
  size_t len = strlen(netlist);
  char *buf = (char *)malloc(len + 2);
  if (!buf) return -1;
  memcpy(buf, netlist, len + 1);

  /* Count lines to size the pointer table. */
  int lines = 1;
  for (size_t i = 0; i < len; i++) if (buf[i] == '\n') lines++;
  char **argv = (char **)calloc((size_t)lines + 2, sizeof(char *));
  if (!argv) { free(buf); return -1; }

  int n = 0;
  char *p = buf;
  for (;;) {
    char *nl = strchr(p, '\n');
    if (nl) *nl = '\0';
    size_t l = strlen(p);
    if (l && p[l - 1] == '\r') p[l - 1] = '\0';   /* tolerate CRLF */
    argv[n++] = p;
    if (!nl) break;
    p = nl + 1;
  }
  argv[n] = NULL;

  int rc = ngSpice_Circ(argv);
  /* ngspice copies the deck, so both allocations can go immediately. */
  free(argv);
  free(buf);
  return rc;
}

EMSCRIPTEN_KEEPALIVE
int ngw_command(const char *cmd) {
  return ngSpice_Command((char *)cmd);
}

/** Value of a scalar vector in the current plot, or NaN. Used for `.op`. */
EMSCRIPTEN_KEEPALIVE
double ngw_vec(const char *name) {
  pvector_info v = ngGet_Vec_Info((char *)name);
  if (!v || v->v_length < 1) return 0.0 / 0.0;
  if (v->v_realdata) return v->v_realdata[v->v_length - 1];
  return 0.0 / 0.0;
}

EMSCRIPTEN_KEEPALIVE
int ngw_running(void) { return ngSpice_running() ? 1 : 0; }
