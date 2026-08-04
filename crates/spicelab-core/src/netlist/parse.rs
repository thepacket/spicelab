//! Netlist text -> syntax tree. No semantics: nothing here evaluates a
//! parameter, resolves a model, or knows what a resistor is.
//!
//! SPICE lexical rules implemented:
//!
//! * The first line is the title, by long-standing convention. A leading `.`
//!   or a recognisable element letter overrides that, so embedded fragments and
//!   library files parse without a dummy first line.
//! * `*` at the start of a line is a comment; `;` starts a comment anywhere.
//! * A line beginning with `+` continues the previous line.
//! * Everything is case-insensitive. Names are kept in their original case for
//!   display but compared lowercased.
//! * `{...}`, `'...'` and `(...)` group as single tokens, so `PULSE(0 1 0 1n)`
//!   and `{r*2}` survive whitespace splitting intact.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    pub line: usize,
    pub message: String,
    /// Whether the netlist is WRONG or merely beyond this engine.
    ///
    /// The distinction is what lets a caller route: a `Unsupported` netlist is
    /// valid SPICE that this core does not implement, and handing it to a
    /// bigger engine is the right response. An `Invalid` one is broken, and
    /// silently routing it elsewhere would replace a precise error with a
    /// different engine's less precise one — or, worse, let a second parser
    /// accept something this one rejected and simulate a different circuit.
    pub kind: ErrorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// The netlist is malformed, or names something that does not exist.
    Invalid,
    /// The netlist is well-formed SPICE using a device, model level or analysis
    /// this core does not implement.
    Unsupported,
    /// The netlist references a file (`.include` / `.lib`) that could not be
    /// fetched.
    ///
    /// A THIRD kind because the remedy is different from both others. The
    /// netlist is not malformed and no other engine can help — there is no
    /// filesystem in a browser, so a second simulator would fail the same way.
    /// What the user must do is supply the file's contents. Reporting this as
    /// `Invalid` told them their netlist was broken, which it is not, and
    /// stopped engine selection with the wrong message.
    Unresolved,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Invalid => "invalid",
            ErrorKind::Unsupported => "unsupported",
            ErrorKind::Unresolved => "unresolved",
        }
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ParseError {}

/// An error meaning "this core cannot do that", as opposed to "that is wrong".
/// Callers route on this: see `ErrorKind`.
fn err_kind<T>(
    line: usize,
    message: impl Into<String>,
    kind: ErrorKind,
) -> Result<T, ParseError> {
    Err(ParseError { line, message: message.into(), kind })
}

fn err<T>(line: usize, message: impl Into<String>) -> Result<T, ParseError> {
    Err(ParseError {
        line,
        message: message.into(),
                kind: ErrorKind::Invalid,
            })
}

/// One element instance card, e.g. `R1 in out 1k tc1=0.001`.
#[derive(Debug, Clone, Default)]
pub struct Element {
    /// The leading letter, lowercased: 'r', 'c', 'x', ...
    pub letter: char,
    pub name: String,
    pub nodes: Vec<String>,
    /// Positional arguments after the nodes, unevaluated.
    pub args: Vec<String>,
    /// `key=value` pairs, keys lowercased, values unevaluated.
    pub params: HashMap<String, String>,
    /// Source line, for error messages.
    pub line: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ModelCard {
    pub name: String,
    /// `nmos`, `pnp`, `d`, ... lowercased.
    pub kind: String,
    pub params: HashMap<String, String>,
    pub line: usize,
}

#[derive(Debug, Clone, Default)]
pub struct Subckt {
    pub name: String,
    pub ports: Vec<String>,
    /// Default parameter values from the `.subckt` line, unevaluated.
    pub params: HashMap<String, String>,
    pub cards: Vec<Element>,
    /// Definitions nested inside this one. Resolution searches inner scopes
    /// first, then outward.
    pub subckts: HashMap<String, Subckt>,
    pub models: HashMap<String, ModelCard>,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Analysis {
    Op,
    /// `.tf <output> <input source>` — small-signal gain, input resistance and
    /// output resistance about the operating point.
    Tf {
        output: String,
        input: String,
    },
    Dc {
        source: String,
        start: String,
        stop: String,
        step: String,
    },
    Ac {
        scale: String,
        points: String,
        start: String,
        stop: String,
    },
    Tran {
        tstep: String,
        tstop: String,
        tstart: Option<String>,
        tmax: Option<String>,
        uic: bool,
    },
}

#[derive(Debug, Clone, Default)]
pub struct Netlist {
    pub title: String,
    /// `.param` definitions in declaration order, unevaluated. Order matters:
    /// a later param may reference an earlier one.
    pub params: Vec<(String, String)>,
    pub models: HashMap<String, ModelCard>,
    pub subckts: HashMap<String, Subckt>,
    pub cards: Vec<Element>,
    pub analyses: Vec<Analysis>,
    pub options: HashMap<String, String>,
}

/// Split a card into tokens, keeping `{}`, `''` and `()` groups intact and
/// stripping `;` comments.
///
/// **A comma separates like whitespace.** SPICE has always allowed it, and real
/// vendor models use it — Analog Devices ships the OP177 macromodel with
/// `.MODEL DEN D(IS=1E-12, RS=14.61K, KF=2E-17, AF=1)`. Splitting on whitespace
/// alone leaves the token `IS=1E-12,`, whose value then fails to evaluate, and
/// the netlist is rejected as malformed when it is perfectly ordinary.
///
/// Only at depth 0: inside `{}`, `()` or quotes the comma may be structural
/// (a waveform's argument list, an expression's function call), and those
/// groups are handed on whole to whoever understands them.
fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0usize;
    let mut quote = false;
    for ch in s.chars() {
        if quote {
            cur.push(ch);
            if ch == '\'' {
                quote = false;
            }
            continue;
        }
        match ch {
            ';' if depth == 0 => break,
            '\'' => {
                quote = true;
                cur.push(ch);
            }
            '{' | '(' => {
                depth += 1;
                cur.push(ch);
            }
            '}' | ')' => {
                depth = depth.saturating_sub(1);
                cur.push(ch);
            }
            c if (c.is_whitespace() || c == ',') && depth == 0 => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            // A bare '=' separates key and value; normalise "a = b" to "a=b"
            // by gluing across whitespace is handled below in `pair_up`.
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Rejoin tokens split around a lone `=`, so `w = 10u` becomes `w=10u`.
fn pair_up(toks: Vec<String>) -> Vec<String> {
    // `PARAMS:` is a PSpice-family keyword introducing a subcircuit's parameter
    // list, on both the definition and the instance:
    //
    //     .SUBCKT SUB1 a b PARAMS: RVAL=1
    //     X1 2 3 SUB1 PARAMS: RVAL=2
    //
    // It carries no information beyond "key=value pairs follow", which is
    // already unambiguous, so it is dropped here rather than special-cased at
    // every site that reads positional arguments. Leaving it in made the token
    // after the subcircuit name look positional, so the name did not resolve
    // and a perfectly ordinary vendor macromodel was reported as referencing an
    // undefined subcircuit.
    let toks: Vec<String> = toks
        .into_iter()
        .filter(|t| !t.eq_ignore_ascii_case("params:"))
        .collect();
    let mut out: Vec<String> = Vec::with_capacity(toks.len());
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        if t == "=" && !out.is_empty() && i + 1 < toks.len() {
            let last = out.pop().unwrap();
            out.push(format!("{last}={}", toks[i + 1]));
            i += 2;
            continue;
        }
        if t.ends_with('=') && i + 1 < toks.len() {
            out.push(format!("{t}{}", toks[i + 1]));
            i += 2;
            continue;
        }
        if t.starts_with('=') && !out.is_empty() {
            let last = out.pop().unwrap();
            out.push(format!("{last}{t}"));
            i += 1;
            continue;
        }
        out.push(t.clone());
        i += 1;
    }
    out
}

/// Split trailing `key=value` tokens off the positional ones.
fn split_params(toks: &[String]) -> (Vec<String>, HashMap<String, String>) {
    let mut pos = Vec::new();
    let mut params = HashMap::new();
    for t in toks {
        if let Some(eq) = t.find('=') {
            // Guard against an expression that merely contains '=' (e.g. "a>=b"
            // inside braces) by requiring a plain identifier on the left.
            let (k, v) = t.split_at(eq);
            let key = k.trim();
            if !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_')
                && key.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_')
            {
                params.insert(key.to_lowercase(), v[1..].trim().to_string());
                continue;
            }
        }
        pos.push(t.clone());
    }
    (pos, params)
}

/// Physical lines joined into logical cards, paired with their first line
/// number and with comments stripped.
fn logical_lines(src: &str) -> Vec<(usize, String)> {
    let mut out: Vec<(usize, String)> = Vec::new();
    for (i, raw) in src.lines().enumerate() {
        let lineno = i + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('*') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('+') {
            if let Some(last) = out.last_mut() {
                last.1.push(' ');
                last.1.push_str(rest.trim());
                continue;
            }
            // A continuation with nothing to continue: treat as its own card.
            out.push((lineno, rest.trim().to_string()));
            continue;
        }
        out.push((lineno, trimmed.to_string()));
    }
    out
}

/// Does this line start a card rather than being a free-text title?
///
/// ONLY a leading `.` counts. This looked like a place for a smarter heuristic
/// — "does it parse as an element card?" — and that heuristic is actively
/// harmful, because element prefixes are ordinary English initials. Under it,
/// the title "divider from schematic" parsed as a DIODE named `divider` between
/// nodes `from` and `schematic`, and "Common emitter amplifier" would parse as
/// a capacitor. The failure is quiet: you lose a component and gain a title, or
/// the reverse.
///
/// So this follows the SPICE convention exactly: the first line is the title,
/// full stop. The one concession is a leading `.`, which lets library fragments
/// and `.subckt` files parse without a placeholder first line — and no
/// directive can be mistaken for prose.
fn looks_like_card(s: &str) -> bool {
    s.starts_with('.')
}

/// Resolve `.include` / `.lib` directives by name. Returning `Err` aborts the
/// parse; the string is used as the error message.
pub type Resolver<'a> = &'a mut dyn FnMut(&str) -> Result<String, String>;

/// Parse a netlist with no `.include` support.
pub fn parse(src: &str) -> Result<Netlist, ParseError> {
    let mut none = |name: &str| Err(format!("`.include {name}` requires a resolver"));
    parse_with(src, &mut none)
}

/// Parse a netlist, resolving `.include` and `.lib` through `resolver`.
///
/// The resolver indirection exists so the same parser serves native (read from
/// disk) and wasm (read from a virtual filesystem supplied by the host), which
/// has no filesystem of its own.
pub fn parse_with(src: &str, resolver: Resolver) -> Result<Netlist, ParseError> {
    let mut nl = Netlist::default();
    let lines = logical_lines(src);

    let mut start = 0;
    if let Some((_, first)) = lines.first() {
        if !looks_like_card(first) {
            nl.title = first.clone();
            start = 1;
        }
    }

    let mut depth_guard = 0usize;
    parse_cards(&lines[start..], &mut nl, resolver, &mut depth_guard)?;
    Ok(nl)
}

/// Where a card should be filed: the top-level netlist, or a subcircuit under
/// construction.
enum Sink<'a> {
    Top(&'a mut Netlist),
    Sub(&'a mut Subckt),
}

impl Sink<'_> {
    fn push_card(&mut self, e: Element) {
        match self {
            Sink::Top(n) => n.cards.push(e),
            Sink::Sub(s) => s.cards.push(e),
        }
    }
    fn push_model(&mut self, m: ModelCard) {
        match self {
            Sink::Top(n) => {
                n.models.insert(m.name.to_lowercase(), m);
            }
            Sink::Sub(s) => {
                s.models.insert(m.name.to_lowercase(), m);
            }
        }
    }
}

fn parse_cards(
    lines: &[(usize, String)],
    nl: &mut Netlist,
    resolver: Resolver,
    include_depth: &mut usize,
) -> Result<(), ParseError> {
    let mut i = 0;
    while i < lines.len() {
        let (lineno, text) = &lines[i];
        i += 1;
        let toks = pair_up(tokenize(text));
        if toks.is_empty() {
            continue;
        }
        let head = toks[0].to_lowercase();

        if head == ".end" {
            break;
        }
        if head == ".subckt" {
            // Collect through the matching .ends, honouring nesting.
            let mut depth = 1usize;
            let body_start = i;
            while i < lines.len() {
                let h = lines[i].1.split_whitespace().next().unwrap_or("").to_lowercase();
                if h == ".subckt" {
                    depth += 1;
                } else if h == ".ends" || h == ".eom" {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                i += 1;
            }
            if depth != 0 {
                return err(*lineno, "unterminated .subckt (missing .ends)");
            }
            let body = &lines[body_start..i];
            i += 1; // consume .ends
            let sub = parse_subckt(*lineno, &toks, body, resolver, include_depth)?;
            nl.subckts.insert(sub.name.to_lowercase(), sub);
            continue;
        }

        if head == ".include" || head == ".inc" || head == ".lib" {
            if toks.len() < 2 {
                return err(*lineno, format!("{head} needs a file name"));
            }
            *include_depth += 1;
            if *include_depth > 32 {
                return err(*lineno, "include nesting too deep (circular .include?)");
            }
            let name = toks[1].trim_matches('"').trim_matches('\'');
            let text = resolver(name).map_err(|e| ParseError {
                line: *lineno,
                message: e,
                kind: ErrorKind::Unresolved,
            })?;
            let sub_lines = logical_lines(&text);
            parse_cards(&sub_lines, nl, resolver, include_depth)?;
            *include_depth -= 1;
            continue;
        }

        let mut sink = Sink::Top(nl);
        parse_one(*lineno, &toks, &mut sink)?;
    }
    Ok(())
}

fn parse_subckt(
    lineno: usize,
    header: &[String],
    body: &[(usize, String)],
    resolver: Resolver,
    include_depth: &mut usize,
) -> Result<Subckt, ParseError> {
    if header.len() < 2 {
        return err(lineno, ".subckt needs a name");
    }
    let (pos, params) = split_params(&header[1..]);
    let mut sub = Subckt {
        name: pos[0].clone(),
        ports: pos[1..].to_vec(),
        params,
        line: lineno,
        ..Default::default()
    };
    // A `params:` keyword may separate ports from defaults; drop it if present.
    sub.ports.retain(|p| p.to_lowercase() != "params:");

    let mut i = 0;
    while i < body.len() {
        let (ln, text) = &body[i];
        i += 1;
        let toks = pair_up(tokenize(text));
        if toks.is_empty() {
            continue;
        }
        let head = toks[0].to_lowercase();
        if head == ".subckt" {
            let mut depth = 1usize;
            let start = i;
            while i < body.len() {
                let h = body[i].1.split_whitespace().next().unwrap_or("").to_lowercase();
                if h == ".subckt" {
                    depth += 1;
                } else if h == ".ends" || h == ".eom" {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                i += 1;
            }
            if depth != 0 {
                return err(*ln, "unterminated nested .subckt");
            }
            let inner = parse_subckt(*ln, &toks, &body[start..i], resolver, include_depth)?;
            i += 1;
            sub.subckts.insert(inner.name.to_lowercase(), inner);
            continue;
        }
        let mut sink = Sink::Sub(&mut sub);
        parse_one(*ln, &toks, &mut sink)?;
    }
    Ok(sub)
}

/// Parse a single non-structural card into the given sink.
fn parse_one(lineno: usize, toks: &[String], sink: &mut Sink) -> Result<(), ParseError> {
    let head = toks[0].to_lowercase();

    if let Some(dot) = head.strip_prefix('.') {
        match dot {
            "param" | "params" => {
                let (_, params) = split_params(&toks[1..]);
                if let Sink::Top(n) = sink {
                    for (k, v) in params {
                        n.params.push((k, v));
                    }
                } else if let Sink::Sub(s) = sink {
                    // A `.param` inside a subcircuit becomes a local default.
                    for (k, v) in params {
                        s.params.insert(k, v);
                    }
                }
                return Ok(());
            }
            "model" => {
                if toks.len() < 3 {
                    return err(lineno, ".model needs a name and a type");
                }
                let (_, params) = split_params(&toks[3..]);
                // Parameters may also be wrapped: .model X D (is=1e-14 n=1)
                let mut params = params;
                if toks.len() >= 3 {
                    let joined = toks[3..].join(" ");
                    let inner = joined.trim();
                    if inner.starts_with('(') {
                        let stripped = inner.trim_start_matches('(').trim_end_matches(')');
                        let (_, more) = split_params(&pair_up(tokenize(stripped)));
                        params.extend(more);
                    }
                }
                // The type token itself may carry the paren group: "D(is=1e-14)"
                let kind_tok = &toks[2];
                let kind = kind_tok
                    .split('(')
                    .next()
                    .unwrap_or(kind_tok)
                    .to_lowercase();
                if let Some(open) = kind_tok.find('(') {
                    let inner = kind_tok[open + 1..].trim_end_matches(')');
                    let (_, more) = split_params(&pair_up(tokenize(inner)));
                    params.extend(more);
                }
                sink.push_model(ModelCard {
                    name: toks[1].clone(),
                    kind,
                    params,
                    line: lineno,
                });
                return Ok(());
            }
            "op" => {
                if let Sink::Top(n) = sink {
                    n.analyses.push(Analysis::Op);
                }
                return Ok(());
            }
            "tf" => {
                // `.tf <output> <input source>`. The output is written as a
                // node name here rather than SPICE's `V(out)` spelling as well
                // as it; both are accepted, because vendor and textbook decks
                // use `V(out)` almost universally and rejecting it would be a
                // gratuitous difference.
                if toks.len() < 3 {
                    return err(lineno, ".tf needs an output and an input source");
                }
                let out = toks[1].trim();
                let out = out
                    .strip_prefix("V(")
                    .or_else(|| out.strip_prefix("v("))
                    .and_then(|s| s.strip_suffix(')'))
                    .unwrap_or(out)
                    .to_string();
                if let Sink::Top(n) = sink {
                    n.analyses.push(Analysis::Tf {
                        output: out,
                        input: toks[2].clone(),
                    });
                }
                return Ok(());
            }
            "dc" => {
                if toks.len() < 5 {
                    return err(lineno, ".dc needs source, start, stop, step");
                }
                if let Sink::Top(n) = sink {
                    n.analyses.push(Analysis::Dc {
                        source: toks[1].clone(),
                        start: toks[2].clone(),
                        stop: toks[3].clone(),
                        step: toks[4].clone(),
                    });
                }
                return Ok(());
            }
            "ac" => {
                if toks.len() < 5 {
                    return err(lineno, ".ac needs scale, points, start, stop");
                }
                if let Sink::Top(n) = sink {
                    n.analyses.push(Analysis::Ac {
                        scale: toks[1].to_lowercase(),
                        points: toks[2].clone(),
                        start: toks[3].clone(),
                        stop: toks[4].clone(),
                    });
                }
                return Ok(());
            }
            "tran" => {
                if toks.len() < 3 {
                    return err(lineno, ".tran needs at least tstep and tstop");
                }
                let uic = toks.iter().any(|t| t.eq_ignore_ascii_case("uic"));
                let rest: Vec<&String> =
                    toks[1..].iter().filter(|t| !t.eq_ignore_ascii_case("uic")).collect();
                if let Sink::Top(n) = sink {
                    n.analyses.push(Analysis::Tran {
                        tstep: rest[0].clone(),
                        tstop: rest[1].clone(),
                        tstart: rest.get(2).map(|s| (*s).clone()),
                        tmax: rest.get(3).map(|s| (*s).clone()),
                        uic,
                    });
                }
                return Ok(());
            }
            "options" | "option" => {
                let (_, params) = split_params(&toks[1..]);
                if let Sink::Top(n) = sink {
                    n.options.extend(params);
                }
                return Ok(());
            }
            "ends" | "eom" | "end" | "title" | "probe" | "print" | "plot" | "width"
            | "temp" | "nodeset" | "ic" | "save" => {
                // Accepted and ignored: output/formatting directives that do not
                // affect the solved circuit. Ignoring beats rejecting, because a
                // vendor model file is full of them.
                return Ok(());
            }
            other => {
                return err_kind(
                    lineno,
                    format!("unsupported directive '.{other}'"),
                    ErrorKind::Unsupported,
                );
            }
        }
    }

    // Element card.
    let letter = head.chars().next().unwrap_or('?');
    if !"rclkviefghdqmsx".contains(letter) {
        return err_kind(
            lineno,
            format!("unsupported element type '{}'", letter.to_uppercase()),
            ErrorKind::Unsupported,
        );
    }
    let (pos, params) = split_params(&toks[1..]);
    let n_nodes = match letter {
        'r' | 'c' | 'l' | 'd' => 2,
        'v' | 'i' => 2,
        'k' => 0, // K names two inductors, not nodes
        'f' | 'h' => 2, // plus a controlling source name in args
        'e' | 'g' | 's' => 4,
        'q' => {
            // 3 or 4 terminals; the 4th is a node only if a model name follows.
            if pos.len() >= 5 {
                4
            } else {
                3
            }
        }
        'm' => 4,
        'x' => pos.len().saturating_sub(1), // all but the subckt name
        _ => 2,
    };
    if pos.len() < n_nodes {
        // A short E or G is usually not a broken card: it is a PSpice-family
        // BEHAVIOURAL source, which takes two nodes and an expression where a
        // plain controlled source takes four nodes and a gain.
        //
        //     ERES 1 3 value={I(VSENSE)*...}
        //     E1 5 4 VALUE={IF((V(1)>V(2)), V(4)+5V, V(4))}
        //     G1 out 0 TABLE {V(a)} = (0,0) (1,1)
        //
        // Both spellings occur and `pair_up` glues `value={...}` into a single
        // token, so the keyword is matched with and without the `=`. Vendor
        // macromodels use these constantly — 70+ files in one library — and
        // calling them malformed both blamed the vendor's file and stopped it
        // routing to an engine that implements them.
        if matches!(letter, 'e' | 'g') {
            let behavioural = toks.iter().any(|t| {
                let t = t.to_lowercase();
                ["value", "table", "laplace", "freq", "poly"]
                    .iter()
                    .any(|k| t == *k || t.starts_with(&format!("{k}=")))
            });
            if behavioural {
                return err_kind(
                    lineno,
                    format!("{}: behavioural sources are not implemented", toks[0]),
                    ErrorKind::Unsupported,
                );
            }
        }
        return err(
            lineno,
            format!(
                "{} needs {} nodes, found {}",
                toks[0],
                n_nodes,
                pos.len()
            ),
        );
    }
    sink.push_card(Element {
        letter,
        name: toks[0].clone(),
        nodes: pos[..n_nodes].to_vec(),
        args: pos[n_nodes..].to_vec(),
        params,
        line: lineno,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_lines_join() {
        let nl = parse("test\nR1 a b\n+ 1k\n.end\n").unwrap();
        assert_eq!(nl.cards.len(), 1);
        assert_eq!(nl.cards[0].nodes, vec!["a", "b"]);
        assert_eq!(nl.cards[0].args, vec!["1k"]);
    }

    #[test]
    fn comments_are_stripped() {
        let nl = parse("title\n* whole line\nR1 a b 1k ; trailing\n").unwrap();
        assert_eq!(nl.cards.len(), 1);
        assert_eq!(nl.cards[0].args, vec!["1k"]);
    }

    #[test]
    fn title_detection() {
        // Free text first line is a title.
        let nl = parse("My Amplifier\nR1 a b 1k\n").unwrap();
        assert_eq!(nl.title, "My Amplifier");
        assert_eq!(nl.cards.len(), 1);

        // The SPICE rule: line 1 is ALWAYS the title, even when it looks like a
        // card. Consuming it as a component instead is the more surprising
        // failure, and it is the one that bites — see `looks_like_card`.
        let nl = parse("R1 a b 1k\nR2 b 0 2k\n").unwrap();
        assert_eq!(nl.title, "R1 a b 1k");
        assert_eq!(nl.cards.len(), 1);

        // A leading directive is unambiguous, so library fragments still parse
        // without a placeholder first line.
        let nl = parse(".model DX D is=1e-15\nR1 a b 1k\n").unwrap();
        assert_eq!(nl.title, "");
        assert!(nl.models.contains_key("dx"));
        assert_eq!(nl.cards.len(), 1);
    }

    /// Regression: an ordinary English title must never be eaten as a card.
    /// Every one of these begins with a letter that is also an element prefix.
    #[test]
    fn prose_titles_are_not_parsed_as_components() {
        for title in [
            "divider from schematic",
            "Common emitter amplifier",
            "Regulated supply rev 2",
            "Low pass filter stage",
            "Half wave rectifier test",
            "Miller integrator check",
        ] {
            let src = format!("{title}\nR1 a 0 1k\n");
            let nl = parse(&src).unwrap_or_else(|e| panic!("{title}: {e}"));
            assert_eq!(nl.title, title, "title was consumed as a card");
            assert_eq!(nl.cards.len(), 1, "{title}: wrong card count");
            assert_eq!(nl.cards[0].name, "R1");
        }
    }

    #[test]
    fn key_value_pairs_tolerate_spaces() {
        let nl = parse("t\nM1 d g s b nmos w = 10u l=1u\n").unwrap();
        let e = &nl.cards[0];
        assert_eq!(e.params.get("w").map(String::as_str), Some("10u"));
        assert_eq!(e.params.get("l").map(String::as_str), Some("1u"));
        assert_eq!(e.args, vec!["nmos"]);
    }

    #[test]
    fn brace_groups_survive_splitting() {
        let nl = parse("t\nR1 a b {rbase*2}\n").unwrap();
        assert_eq!(nl.cards[0].args, vec!["{rbase*2}"]);
        let nl = parse("t\nV1 a 0 PULSE(0 1 0 1n 1n 1u 2u)\n").unwrap();
        assert_eq!(nl.cards[0].args, vec!["PULSE(0 1 0 1n 1n 1u 2u)"]);
    }

    #[test]
    fn model_cards_both_syntaxes() {
        let nl = parse("t\n.model DX D is=1e-15 n=1.2\n").unwrap();
        let m = &nl.models["dx"];
        assert_eq!(m.kind, "d");
        assert_eq!(m.params["is"], "1e-15");
        let nl = parse("t\n.model DY D(is=2e-15 rs=0.5)\n").unwrap();
        let m = &nl.models["dy"];
        assert_eq!(m.kind, "d");
        assert_eq!(m.params["is"], "2e-15");
        assert_eq!(m.params["rs"], "0.5");
    }

    #[test]
    fn subckt_with_ports_and_params() {
        let src = "t\n.subckt div in out params: r=1k\nR1 in out {r}\nR2 out 0 {r}\n.ends\n";
        let nl = parse(src).unwrap();
        let s = &nl.subckts["div"];
        assert_eq!(s.ports, vec!["in", "out"]);
        assert_eq!(s.params["r"], "1k");
        assert_eq!(s.cards.len(), 2);
    }

    #[test]
    fn nested_subckt_definitions() {
        let src = "t\n.subckt outer a b\n.subckt inner c d\nR1 c d 1k\n.ends\nX1 a b inner\n.ends\n";
        let nl = parse(src).unwrap();
        let outer = &nl.subckts["outer"];
        assert!(outer.subckts.contains_key("inner"));
        assert_eq!(outer.cards.len(), 1);
        assert_eq!(outer.cards[0].letter, 'x');
    }

    #[test]
    fn unterminated_subckt_is_an_error() {
        let e = parse("t\n.subckt a b c\nR1 b c 1k\n").unwrap_err();
        assert!(e.message.contains("unterminated"), "{}", e.message);
    }

    #[test]
    fn analyses_parse() {
        let nl = parse("t\n.op\n.tran 1u 1m uic\n.ac dec 20 1 1meg\n.dc V1 0 5 0.1\n").unwrap();
        assert_eq!(nl.analyses.len(), 4);
        assert!(matches!(nl.analyses[0], Analysis::Op));
        match &nl.analyses[1] {
            Analysis::Tran { tstep, tstop, uic, .. } => {
                assert_eq!(tstep, "1u");
                assert_eq!(tstop, "1m");
                assert!(uic);
            }
            _ => panic!("expected tran"),
        }
    }

    #[test]
    fn bjt_three_and_four_terminal() {
        let nl = parse("t\nQ1 c b e QMOD\nQ2 c b e s QMOD\n").unwrap();
        assert_eq!(nl.cards[0].nodes.len(), 3);
        assert_eq!(nl.cards[0].args, vec!["QMOD"]);
        assert_eq!(nl.cards[1].nodes.len(), 4);
        assert_eq!(nl.cards[1].args, vec!["QMOD"]);
    }

    #[test]
    fn include_uses_the_resolver() {
        let mut r = |name: &str| {
            assert_eq!(name, "lib.cir");
            Ok(".model DX D is=1e-15\n".to_string())
        };
        let nl = parse_with("t\n.include lib.cir\nD1 a 0 DX\n", &mut r).unwrap();
        assert!(nl.models.contains_key("dx"));
        assert_eq!(nl.cards.len(), 1);
    }

    #[test]
    fn unsupported_directives_report_the_line() {
        let e = parse("t\nR1 a b 1k\n.nonsense 1 2\n").unwrap_err();
        assert_eq!(e.line, 3);
        assert!(e.message.contains("nonsense"));
    }

    /// Output directives appear all over vendor files; rejecting them would
    /// make most real models unloadable.
    #[test]
    fn output_directives_are_ignored() {
        let nl = parse("t\nR1 a 0 1k\n.print tran v(a)\n.probe\n.width out=80\n").unwrap();
        assert_eq!(nl.cards.len(), 1);
    }
}
