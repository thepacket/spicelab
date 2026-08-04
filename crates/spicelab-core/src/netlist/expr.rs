//! SPICE number literals and `.param` expression evaluation.
//!
//! Two things live here because they are inseparable in practice: a SPICE value
//! token may be a bare number with an engineering suffix (`4k7` is not valid but
//! `4.7k`, `1meg`, `10uF` all are), or an arbitrary expression in braces
//! (`{gain*2}`), and a `.param` may define either.
//!
//! The suffix table has one classic trap: `M` means MILLI and `MEG` means
//! MEGA, so `1M` is a thousandth of `1MEG`. Getting that backwards silently
//! scales a component by 10^9. `MEG` and `MIL` must therefore be matched before
//! the single-letter `M`.
//!
//! Trailing unit text is ignored, so `10uF`, `1kOhm` and `5nS` all parse — SPICE
//! has always allowed decorative units after the suffix.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum ExprError {
    Syntax(String),
    UnknownIdent(String),
    UnknownFunction(String),
    BadArity {
        name: String,
        want: &'static str,
        got: usize,
    },
}

/// Simulator-provided variables that a netlist may legitimately reference and
/// this evaluator does not supply.
///
/// `{freq}` in a resistor value is analog behavioural modelling — the value
/// varies with the AC analysis frequency. `temper` is the sweep temperature.
/// These are BUILT-INS of the language, not user parameters, so an expression
/// using one is valid SPICE this core does not implement, and must be reported
/// as such rather than as an undefined name.
const BUILTIN_VARS: &[&str] = &[
    "freq", "hertz", "time", "temper", "temp", "vt",
    // Bare `exp` and `pi` are the CONSTANTS e and pi in the PSpice/Xyce
    // family, not calls. `exp` is also a function name here, so without this
    // an expression like `{exp}` came back as an undefined parameter — which
    // blames the user for writing something their simulator documents.
    "exp", "pi",
];

impl ExprError {
    /// Whether this failure means "not implemented here" rather than "wrong".
    ///
    /// The distinction drives engine selection: `unsupported` falls through to
    /// a bigger engine, `invalid` stops and blames the netlist. An unknown
    /// FUNCTION is nearly always a feature gap — this evaluator has about a
    /// dozen built-ins where ngspice and Xyce have many more, plus user
    /// definitions via `.func`, which is not implemented at all. Treating that
    /// as a malformed netlist told the user their deck was broken AND stopped
    /// it reaching the engine that implements the function.
    ///
    /// An unknown IDENT is deliberately NOT included in general: a misspelled
    /// parameter is a real, common mistake and reporting it precisely is worth
    /// more than routing it onward. Only the known built-in variables above
    /// count as unimplemented.
    pub fn is_unsupported(&self) -> bool {
        match self {
            ExprError::UnknownFunction(_) => true,
            ExprError::UnknownIdent(n) => {
                BUILTIN_VARS.contains(&n.to_lowercase().as_str())
            }
            _ => false,
        }
    }
}

impl std::fmt::Display for ExprError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExprError::Syntax(m) => write!(f, "malformed expression: {m}"),
            ExprError::UnknownIdent(n) => write!(f, "undefined parameter '{n}'"),
            ExprError::UnknownFunction(n) => write!(f, "unknown function '{n}'"),
            ExprError::BadArity { name, want, got } => {
                write!(f, "{name}() takes {want} arguments, got {got}")
            }
        }
    }
}

/// Parse a bare SPICE number with an optional engineering suffix and optional
/// decorative unit text. Returns `None` if the token does not start with a
/// number, so callers can distinguish "not a number" from "malformed number".
pub fn parse_number(tok: &str) -> Option<f64> {
    let s = tok.trim();
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();

    // Mantissa: [+-]? digits [. digits] [eE [+-] digits]
    let mut i = 0;
    if bytes[i] == b'+' || bytes[i] == b'-' {
        i += 1;
    }
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i == digits_start {
        return None; // no digits at all
    }
    // An exponent only counts if digits actually follow it, so that the `E`
    // suffix-less form and a trailing unit like "1e" degrade gracefully.
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let k = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > k {
            i = j;
        }
    }

    let mantissa: f64 = s[..i].parse().ok()?;
    let rest = s[i..].to_ascii_lowercase();

    // MEG and MIL must be tested before the single-letter M.
    let mult = if rest.starts_with("meg") {
        1e6
    } else if rest.starts_with("mil") {
        25.4e-6
    } else if rest.is_empty() {
        1.0
    } else {
        // Match the first CHARACTER, not the first byte.
        //
        // `rest.as_bytes()[0]` sees 0xC2 for a UTF-8 micro sign, which fell
        // through to the decorative-unit branch — so `470µF` evaluated to 470,
        // not 470e-6. A 470 uF capacitor became 470 FARADS, silently, and the
        // simulation ran and produced a believable wrong waveform. Real files
        // are full of this: LTspice and vendor libraries write `µ` constantly.
        //
        // Two codepoints mean micro and both appear in the wild: U+00B5 MICRO
        // SIGN (what Latin-1 and most keyboards produce) and U+03BC GREEK SMALL
        // LETTER MU (what some editors substitute). They look identical.
        match rest.chars().next().unwrap_or(' ') {
            't' => 1e12,
            'g' => 1e9,
            'k' => 1e3,
            'm' => 1e-3,
            'u' | '\u{00B5}' | '\u{03BC}' => 1e-6,
            'n' => 1e-9,
            'p' => 1e-12,
            'f' => 1e-15,
            'a' => 1e-18,
            // Anything else is decorative unit text: "10ohm", "2volt".
            _ => 1.0,
        }
    };
    Some(mantissa * mult)
}

/// Evaluate an expression against a parameter table.
///
/// Accepts either a bare value (`1k`) or an expression, with or without the
/// surrounding braces SPICE uses (`{a*2}`, `'a*2'`).
pub fn eval(src: &str, params: &HashMap<String, f64>) -> Result<f64, ExprError> {
    let s = src.trim();
    let s = if (s.starts_with('{') && s.ends_with('}'))
        || (s.starts_with('\'') && s.ends_with('\''))
    {
        &s[1..s.len() - 1]
    } else {
        s
    };
    let mut p = Parser {
        toks: tokenize(s)?,
        pos: 0,
        params,
    };
    let v = p.expr()?;
    if p.pos != p.toks.len() {
        return Err(ExprError::Syntax(format!(
            "trailing input at token {}",
            p.pos
        )));
    }
    Ok(v)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Ident(String),
    Op(String),
    LParen,
    RParen,
    Comma,
}

fn tokenize(s: &str) -> Result<Vec<Tok>, ExprError> {
    let b: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '(' {
            out.push(Tok::LParen);
            i += 1;
            continue;
        }
        if c == ')' {
            out.push(Tok::RParen);
            i += 1;
            continue;
        }
        if c == ',' {
            out.push(Tok::Comma);
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && i + 1 < b.len() && b[i + 1].is_ascii_digit()) {
            // Consume the longest run that could be a suffixed number, then let
            // parse_number decide where the value actually ends.
            let start = i;
            while i < b.len() && (b[i].is_alphanumeric() || b[i] == '.') {
                // Stop before an exponent sign is mistaken for an operator.
                if (b[i] == 'e' || b[i] == 'E')
                    && i + 1 < b.len()
                    && (b[i + 1] == '+' || b[i + 1] == '-')
                    && i + 2 < b.len()
                    && b[i + 2].is_ascii_digit()
                {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            let text: String = b[start..i].iter().collect();
            let v = parse_number(&text)
                .ok_or_else(|| ExprError::Syntax(format!("bad number '{text}'")))?;
            out.push(Tok::Num(v));
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < b.len() && (b[i].is_alphanumeric() || b[i] == '_') {
                i += 1;
            }
            out.push(Tok::Ident(b[start..i].iter().collect()));
            continue;
        }
        // Multi-character operators first.
        let two: String = b[i..(i + 2).min(b.len())].iter().collect();
        if ["**", "<=", ">=", "==", "!=", "&&", "||"].contains(&two.as_str()) {
            out.push(Tok::Op(two));
            i += 2;
            continue;
        }
        if "+-*/%^<>!?:".contains(c) {
            out.push(Tok::Op(c.to_string()));
            i += 1;
            continue;
        }
        return Err(ExprError::Syntax(format!("unexpected character '{c}'")));
    }
    Ok(out)
}

struct Parser<'a> {
    toks: Vec<Tok>,
    pos: usize,
    params: &'a HashMap<String, f64>,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn eat_op(&mut self, op: &str) -> bool {
        if let Some(Tok::Op(o)) = self.peek() {
            if o == op {
                self.pos += 1;
                return true;
            }
        }
        false
    }

    fn expr(&mut self) -> Result<f64, ExprError> {
        self.ternary()
    }

    fn ternary(&mut self) -> Result<f64, ExprError> {
        let cond = self.logic_or()?;
        if self.eat_op("?") {
            let a = self.expr()?;
            if !self.eat_op(":") {
                return Err(ExprError::Syntax("expected ':' in ?: expression".into()));
            }
            let b = self.expr()?;
            return Ok(if cond != 0.0 { a } else { b });
        }
        Ok(cond)
    }

    fn logic_or(&mut self) -> Result<f64, ExprError> {
        let mut v = self.logic_and()?;
        while self.eat_op("||") {
            let r = self.logic_and()?;
            v = bool_val(v != 0.0 || r != 0.0);
        }
        Ok(v)
    }

    fn logic_and(&mut self) -> Result<f64, ExprError> {
        let mut v = self.equality()?;
        while self.eat_op("&&") {
            let r = self.equality()?;
            v = bool_val(v != 0.0 && r != 0.0);
        }
        Ok(v)
    }

    fn equality(&mut self) -> Result<f64, ExprError> {
        let mut v = self.relational()?;
        loop {
            if self.eat_op("==") {
                let r = self.relational()?;
                v = bool_val(v == r);
            } else if self.eat_op("!=") {
                let r = self.relational()?;
                v = bool_val(v != r);
            } else {
                return Ok(v);
            }
        }
    }

    fn relational(&mut self) -> Result<f64, ExprError> {
        let mut v = self.additive()?;
        loop {
            if self.eat_op("<=") {
                let r = self.additive()?;
                v = bool_val(v <= r);
            } else if self.eat_op(">=") {
                let r = self.additive()?;
                v = bool_val(v >= r);
            } else if self.eat_op("<") {
                let r = self.additive()?;
                v = bool_val(v < r);
            } else if self.eat_op(">") {
                let r = self.additive()?;
                v = bool_val(v > r);
            } else {
                return Ok(v);
            }
        }
    }

    fn additive(&mut self) -> Result<f64, ExprError> {
        let mut v = self.multiplicative()?;
        loop {
            if self.eat_op("+") {
                v += self.multiplicative()?;
            } else if self.eat_op("-") {
                v -= self.multiplicative()?;
            } else {
                return Ok(v);
            }
        }
    }

    fn multiplicative(&mut self) -> Result<f64, ExprError> {
        let mut v = self.unary()?;
        loop {
            if self.eat_op("*") {
                v *= self.unary()?;
            } else if self.eat_op("/") {
                v /= self.unary()?;
            } else if self.eat_op("%") {
                let r = self.unary()?;
                v %= r;
            } else {
                return Ok(v);
            }
        }
    }

    fn unary(&mut self) -> Result<f64, ExprError> {
        if self.eat_op("-") {
            return Ok(-self.unary()?);
        }
        if self.eat_op("+") {
            return self.unary();
        }
        if self.eat_op("!") {
            return Ok(bool_val(self.unary()? == 0.0));
        }
        self.power()
    }

    fn power(&mut self) -> Result<f64, ExprError> {
        let base = self.primary()?;
        if self.eat_op("**") || self.eat_op("^") {
            // Right-associative, and binds tighter than unary minus on the left.
            let e = self.unary()?;
            return Ok(base.powf(e));
        }
        Ok(base)
    }

    fn primary(&mut self) -> Result<f64, ExprError> {
        match self.peek().cloned() {
            Some(Tok::Num(v)) => {
                self.pos += 1;
                Ok(v)
            }
            Some(Tok::LParen) => {
                self.pos += 1;
                let v = self.expr()?;
                if !matches!(self.peek(), Some(Tok::RParen)) {
                    return Err(ExprError::Syntax("expected ')'".into()));
                }
                self.pos += 1;
                Ok(v)
            }
            Some(Tok::Ident(name)) => {
                self.pos += 1;
                if matches!(self.peek(), Some(Tok::LParen)) {
                    self.pos += 1;
                    let mut args = Vec::new();
                    if !matches!(self.peek(), Some(Tok::RParen)) {
                        loop {
                            args.push(self.expr()?);
                            if matches!(self.peek(), Some(Tok::Comma)) {
                                self.pos += 1;
                                continue;
                            }
                            break;
                        }
                    }
                    if !matches!(self.peek(), Some(Tok::RParen)) {
                        return Err(ExprError::Syntax(format!("expected ')' after {name}(")));
                    }
                    self.pos += 1;
                    return call(&name, &args);
                }
                let key = name.to_lowercase();
                self.params
                    .get(&key)
                    .copied()
                    .ok_or(ExprError::UnknownIdent(name))
            }
            other => Err(ExprError::Syntax(format!("unexpected {other:?}"))),
        }
    }
}

fn bool_val(b: bool) -> f64 {
    if b {
        1.0
    } else {
        0.0
    }
}

fn call(name: &str, a: &[f64]) -> Result<f64, ExprError> {
    let n = a.len();
    let want = |k: usize, w: &'static str| -> Result<(), ExprError> {
        if n == k {
            Ok(())
        } else {
            Err(ExprError::BadArity {
                name: name.to_string(),
                want: w,
                got: n,
            })
        }
    };
    let lower = name.to_lowercase();
    Ok(match lower.as_str() {
        "abs" => {
            want(1, "1")?;
            a[0].abs()
        }
        "sqrt" => {
            want(1, "1")?;
            a[0].sqrt()
        }
        "exp" => {
            want(1, "1")?;
            a[0].exp()
        }
        "ln" | "log" => {
            want(1, "1")?;
            a[0].ln()
        }
        "log10" => {
            want(1, "1")?;
            a[0].log10()
        }
        "sin" => {
            want(1, "1")?;
            a[0].sin()
        }
        "cos" => {
            want(1, "1")?;
            a[0].cos()
        }
        "tan" => {
            want(1, "1")?;
            a[0].tan()
        }
        "asin" => {
            want(1, "1")?;
            a[0].asin()
        }
        "acos" => {
            want(1, "1")?;
            a[0].acos()
        }
        "atan" => {
            want(1, "1")?;
            a[0].atan()
        }
        "sinh" => {
            want(1, "1")?;
            a[0].sinh()
        }
        "cosh" => {
            want(1, "1")?;
            a[0].cosh()
        }
        "tanh" => {
            want(1, "1")?;
            a[0].tanh()
        }
        "floor" => {
            want(1, "1")?;
            a[0].floor()
        }
        "ceil" => {
            want(1, "1")?;
            a[0].ceil()
        }
        "int" => {
            want(1, "1")?;
            a[0].trunc()
        }
        "sgn" => {
            want(1, "1")?;
            if a[0] > 0.0 {
                1.0
            } else if a[0] < 0.0 {
                -1.0
            } else {
                0.0
            }
        }
        // Unit ramp, as used in behavioural sources.
        "uramp" => {
            want(1, "1")?;
            a[0].max(0.0)
        }
        "u" => {
            want(1, "1")?;
            if a[0] > 0.0 {
                1.0
            } else {
                0.0
            }
        }
        "atan2" => {
            want(2, "2")?;
            a[0].atan2(a[1])
        }
        "pow" => {
            want(2, "2")?;
            a[0].powf(a[1])
        }
        // SPICE `pwr` takes the magnitude; `pwrs` keeps the sign.
        "pwr" => {
            want(2, "2")?;
            a[0].abs().powf(a[1])
        }
        "pwrs" => {
            want(2, "2")?;
            a[0].abs().powf(a[1]) * if a[0] < 0.0 { -1.0 } else { 1.0 }
        }
        "min" => {
            want(2, "2")?;
            a[0].min(a[1])
        }
        "max" => {
            want(2, "2")?;
            a[0].max(a[1])
        }
        "if" => {
            want(3, "3")?;
            if a[0] != 0.0 {
                a[1]
            } else {
                a[2]
            }
        }
        "limit" => {
            want(3, "3")?;
            a[0].max(a[1].min(a[2])).min(a[1].max(a[2]))
        }
        _ => return Err(ExprError::UnknownFunction(name.to_string())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> f64 {
        parse_number(s).unwrap()
    }

    #[test]
    fn engineering_suffixes() {
        assert_eq!(p("1"), 1.0);
        assert_eq!(p("-2.5"), -2.5);
        assert_eq!(p("1e3"), 1000.0);
        assert_eq!(p("1e-3"), 1e-3);
        assert_eq!(p("4.7k"), 4700.0);
        assert_eq!(p("1t"), 1e12);
        assert_eq!(p("2g"), 2e9);
        assert_eq!(p("1u"), 1e-6);
        assert_eq!(p("1n"), 1e-9);
        assert_eq!(p("1p"), 1e-12);
        assert_eq!(p("1f"), 1e-15);
    }

    /// The OTHER trap: the micro SIGN is not the letter u.
    ///
    /// U+00B5 and U+03BC both mean micro and are indistinguishable on screen.
    /// Matching the first BYTE of a UTF-8 string sees 0xC2 for either, falls
    /// through to the "decorative unit text" branch, and returns the mantissa
    /// unscaled — so `470µF` is 470 farads rather than 470 microfarads, with no
    /// error and a perfectly believable waveform. LTspice and vendor libraries
    /// write `µ` constantly, so this is not an edge case.
    #[test]
    fn micro_sign_scales_like_u() {
        let scope = HashMap::new();
        let u = eval("470u", &scope).unwrap();
        near(u, 470e-6);
        near(eval("470\u{00B5}", &scope).unwrap(), u);
        near(eval("470\u{00B5}F", &scope).unwrap(), u);
        near(eval("470\u{03BC}F", &scope).unwrap(), u);
        // And the failure it replaced: not 470.
        assert!((eval("470\u{00B5}F", &scope).unwrap() - 470.0).abs() > 1.0);
        // Decorative text after a real suffix still works, and text with no
        // suffix at all is still just the number.
        near(eval("10ohm", &scope).unwrap(), 10.0);
        near(eval("2volt", &scope).unwrap(), 2.0);
    }

    /// The trap: M is milli, MEG is mega. Confusing them scales by 10^9.
    #[test]
    fn meg_is_not_m() {
        assert_eq!(p("1meg"), 1e6);
        assert_eq!(p("1M"), 1e-3);
        assert_eq!(p("1MEG"), 1e6);
        assert_eq!(p("2Meg"), 2e6);
        assert_eq!(p("1mil"), 25.4e-6);
        assert!((p("1meg") / p("1m") - 1e9).abs() < 1.0);
    }

    #[track_caller]
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() <= 1e-12 * b.abs().max(1.0), "{a} != {b}");
    }

    #[test]
    fn decorative_units_are_ignored() {
        // `10 * 1e-6` is not bit-exactly `1e-5`, so compare with a tolerance.
        near(p("10uF"), 1e-5);
        near(p("1kOhm"), 1000.0);
        near(p("5nS"), 5e-9);
        near(p("3volt"), 3.0);
        // "1megHz" is 1e6 — the MEG prefix wins over the trailing unit text.
        near(p("1megHz"), 1e6);
    }

    #[test]
    fn rejects_non_numbers() {
        assert!(parse_number("abc").is_none());
        assert!(parse_number("").is_none());
        assert!(parse_number("k").is_none());
    }

    fn e(s: &str) -> f64 {
        eval(s, &HashMap::new()).unwrap()
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(e("1+2*3"), 7.0);
        assert_eq!(e("(1+2)*3"), 9.0);
        assert_eq!(e("2**3**2"), 512.0); // right-associative
        assert_eq!(e("-2**2"), -4.0); // unary minus binds looser
        assert_eq!(e("10/4"), 2.5);
        assert_eq!(e("7%3"), 1.0);
    }

    #[test]
    fn functions_and_conditionals() {
        assert_eq!(e("sqrt(16)"), 4.0);
        assert_eq!(e("max(3,7)"), 7.0);
        assert_eq!(e("if(1>0, 5, 9)"), 5.0);
        assert_eq!(e("1>2 ? 10 : 20"), 20.0);
        assert!((e("exp(ln(5))") - 5.0).abs() < 1e-12);
        assert_eq!(e("abs(-3k)"), 3000.0);
    }

    #[test]
    fn params_resolve_case_insensitively() {
        let mut m = HashMap::new();
        m.insert("gain".to_string(), 12.0);
        assert_eq!(eval("{GAIN*2}", &m).unwrap(), 24.0);
        assert_eq!(eval("'gain+1'", &m).unwrap(), 13.0);
        assert!(matches!(
            eval("missing*2", &m),
            Err(ExprError::UnknownIdent(_))
        ));
    }

    #[test]
    fn suffixed_numbers_inside_expressions() {
        assert_eq!(e("2k*3"), 6000.0);
        assert_eq!(e("1meg/1k"), 1000.0);
        assert_eq!(e("1e-6*2"), 2e-6);
    }
}

