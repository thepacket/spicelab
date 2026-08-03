# Contributing

**Pull requests are not accepted.** They are closed automatically by
`.github/workflows/reject-pull-requests.yml`.

That is a statement about this project's capacity, not about your change.

## Why

SpiceLab's results are only worth anything because of the validation discipline
in `CLAUDE.md`. Numerical bugs in a circuit simulator are silent: a sign error
in one Jacobian entry, or a charge stored from the wrong iterate, produces
waveforms that look entirely reasonable and are wrong. Plausibility is not a
test. So every device is checked against a closed form where one exists, and
against ngspice where one does not.

Reviewing an outside change to that standard means reproducing the analysis that
justifies it. Merging one without doing so would quietly remove the reason to
trust any of the numbers.

## What helps instead

**Open an issue.** In particular:

- **A wrong number, with a netlist.** This is the most valuable thing you can
  send. If SpiceLab and another simulator disagree, say which and by how much.
- **A netlist that fails to parse but works elsewhere.** Real-world SPICE input
  has found several parser bugs already — commas as parameter separators, and
  the micro sign being silently ignored so `470µF` became 470 farads.
- **A convergence failure**, with the circuit that causes it.

Reports do not need a fix attached, and a reproducer is worth more than a
diagnosis.

## Forking

The licence is GPL-3.0-or-later. Fork it and take it wherever you want.

<!-- workflow verification, to be deleted -->
