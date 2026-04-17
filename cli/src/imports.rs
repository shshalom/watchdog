use std::collections::HashSet;

/// A symbol defined in a file (type, function, etc.)
#[derive(Debug, Clone)]
pub struct DefinedSymbol {
    pub name: String,
    pub kind: SymbolKind,
}

#[derive(Debug, Clone)]
pub enum SymbolKind {
    Type,
    Function,
}

/// Extract symbols defined in a file.
pub fn extract_definitions(file_path: &str, content: &str) -> Vec<DefinedSymbol> {
    let mut symbols = Vec::new();

    // Type definition keywords (across all languages)
    let type_keywords = [
        "class ", "struct ", "enum ", "interface ", "type ", "protocol ",
        "trait ", "record ", "data class ", "sealed class ", "abstract class ",
        "object ", "typedef ", "typealias ",
    ];

    // Function definition keywords
    let fn_keywords = [
        "func ", "fn ", "function ", "def ", "fun ", "sub ",
        "proc ", "method ",
        "pub fn ", "pub func ",
        "async fn ", "async func ", "async function ", "async def ",
        "private func ", "internal func ", "public func ",
        "static func ", "override func ",
        "private fun ", "internal fun ", "public fun ",
        "export function ", "export default function ",
        "export const ", "export class ",
    ];

    for line in content.lines() {
        let trimmed = line.trim();

        // Skip comments
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*")
            || trimmed.starts_with('*') || trimmed.starts_with("--") || trimmed.starts_with("'''")
            || trimmed.starts_with("\"\"\"")
        {
            continue;
        }

        // Check type definitions
        for keyword in &type_keywords {
            if let Some(name) = extract_name_after(trimmed, keyword) {
                if is_valid_symbol(&name) {
                    symbols.push(DefinedSymbol { name, kind: SymbolKind::Type });
                    break;
                }
            }
        }

        // Check function definitions
        for keyword in &fn_keywords {
            if let Some(name) = extract_name_after(trimmed, keyword) {
                if is_valid_symbol(&name) {
                    symbols.push(DefinedSymbol { name, kind: SymbolKind::Function });
                    break;
                }
            }
        }
    }

    symbols
}

/// Find references to a set of known symbols in file content.
/// Returns the names of symbols that are referenced.
pub fn find_references(content: &str, known_symbols: &[String]) -> Vec<String> {
    if known_symbols.is_empty() {
        return vec![];
    }

    let mut found = HashSet::new();
    let content_lower = content.to_lowercase();

    for symbol in known_symbols {
        // Skip very short names (too many false positives)
        if symbol.len() < 3 {
            continue;
        }

        let sym_lower = symbol.to_lowercase();

        // Check if the symbol appears as a whole word
        if contains_word(&content_lower, &sym_lower) {
            found.insert(symbol.clone());
        }
    }

    found.into_iter().collect()
}

/// Check if content contains the word as a whole word (not a substring of another identifier)
fn contains_word(content: &str, word: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = content[start..].find(word) {
        let abs_pos = start + pos;
        let before_ok = abs_pos == 0 || !content.as_bytes()[abs_pos - 1].is_ascii_alphanumeric();
        let after_pos = abs_pos + word.len();
        let after_ok = after_pos >= content.len() || !content.as_bytes()[after_pos].is_ascii_alphanumeric();

        if before_ok && after_ok {
            return true;
        }
        start = abs_pos + 1;
    }
    false
}

/// Extract the identifier name after a keyword
fn extract_name_after(line: &str, keyword: &str) -> Option<String> {
    // Case-insensitive keyword match but preserve the original name casing
    let line_lower = line.to_lowercase();
    let keyword_lower = keyword.to_lowercase();

    if let Some(pos) = line_lower.find(&keyword_lower) {
        let after = &line[pos + keyword.len()..];
        let name: String = after.chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

/// Check if a name is a valid symbol (not a language keyword or too short)
fn is_valid_symbol(name: &str) -> bool {
    if name.len() < 2 {
        return false;
    }

    let keywords = [
        "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
        "return", "var", "let", "const", "new", "self", "this", "super", "true",
        "false", "nil", "null", "void", "int", "string", "bool", "float", "double",
        "import", "from", "export", "default", "async", "await", "try", "catch",
        "throw", "throws", "where", "in", "is", "as", "guard", "defer", "some",
        "none", "any", "all", "mut", "pub", "crate", "mod", "use", "impl",
        "static", "final", "override", "abstract", "private", "public", "internal",
        "protected", "open", "lazy", "weak", "unowned", "optional",
    ];

    !keywords.contains(&name.to_lowercase().as_str())
}
