import fs from 'fs';
import path from 'path';

const SRC_VIEWS = 'c:\\xampp\\htdocs\\e_barangay2.0\\resources\\views';
const DST_VIEWS = 'c:\\xampp\\htdocs\\e_barangay_vercel\\views';

function walkBladeFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'vendor') continue;
            out.push(...walkBladeFiles(full));
        } else if (entry.name.endsWith('.blade.php')) {
            out.push(full);
        }
    }
    return out;
}

function isEscaped(str, idx) {
    let bs = 0;
    for (let k = idx - 1; k >= 0 && str[k] === '\\'; k--) bs++;
    return bs % 2 === 1;
}

/**
 * Find matching closing ')' starting right after an opening '(' at openIdx.
 */
function findMatchingParen(str, openIdx) {
    let depth = 1;
    let inQuote = null;
    for (let i = openIdx + 1; i < str.length; i++) {
        const ch = str[i];
        if (inQuote) {
            if (ch === inQuote && !isEscaped(str, i)) inQuote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            inQuote = ch;
            continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * Split top-level arguments/elements by comma (outside quotes/brackets).
 */
function splitTopLevelCommas(str) {
    const parts = [];
    let depth = 0;
    let inQuote = null;
    let start = 0;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (inQuote) {
            if (ch === inQuote && !isEscaped(str, i)) inQuote = null;
            continue;
        }
        if (ch === "'" || ch === '"') inQuote = ch;
        else if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(str.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = str.slice(start).trim();
    if (last !== '') parts.push(last);
    return parts;
}

function findTopLevelArrow(str) {
    let depth = 0;
    let inQuote = null;
    for (let i = 0; i < str.length - 1; i++) {
        const ch = str[i];
        if (inQuote) {
            if (ch === inQuote && !isEscaped(str, i)) inQuote = null;
            continue;
        }
        if (ch === "'" || ch === '"') inQuote = ch;
        else if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (depth === 0 && ch === '=' && str[i + 1] === '>') return i;
    }
    return -1;
}

/**
 * Replace a standalone function call fn(a, b, ...) using balanced parens.
 */
function replaceBalancedCall(code, fnRegex, replacer) {
    let out = code;
    let safety = 0;
    while (safety++ < 500) {
        fnRegex.lastIndex = 0;
        const m = fnRegex.exec(out);
        if (!m) break;
        const openIdx = m.index + m[0].length - 1;
        const closeIdx = findMatchingParen(out, openIdx);
        if (closeIdx === -1) break;
        const inner = out.slice(openIdx + 1, closeIdx);
        const replacement = replacer(inner, m);
        out = out.slice(0, m.index) + replacement + out.slice(closeIdx + 1);
    }
    return out;
}

/**
 * Convert PHP array literals `[ 'k' => 'v', ... ]` or mixed `[ $id, 'k' => 'v' ]` to JS objects.
 */
function convertPhpAssocArrays(code) {
    let out = code;
    let safety = 0;
    while (safety++ < 500) {
        let inQuote = null;
        let foundArrow = -1;
        for (let i = 0; i < out.length - 1; i++) {
            const ch = out[i];
            if (inQuote) {
                if (ch === inQuote && !isEscaped(out, i)) inQuote = null;
                continue;
            }
            if (ch === "'" || ch === '"') { inQuote = ch; continue; }
            if (ch === '=' && out[i + 1] === '>') {
                foundArrow = i;
                break;
            }
        }
        if (foundArrow === -1) break;

        // Walk backward to find enclosing '['
        let depth = 0;
        let openBracket = -1;
        inQuote = null;
        for (let i = foundArrow - 1; i >= 0; i--) {
            const ch = out[i];
            if (inQuote) {
                if (ch === inQuote && !isEscaped(out, i)) inQuote = null;
                continue;
            }
            if (ch === "'" || ch === '"') { inQuote = ch; continue; }
            if (ch === ']' || ch === '}' || ch === ')') depth++;
            else if (ch === '[' || ch === '{' || ch === '(') {
                if (depth === 0) {
                    if (ch === '[') openBracket = i;
                    break;
                }
                depth--;
            }
        }

        if (openBracket === -1) {
            // Fallback: replace orphan => with ':' so loop cannot stall
            out = out.slice(0, foundArrow) + ' : ' + out.slice(foundArrow + 2);
            continue;
        }

        // Find matching ']'
        depth = 1;
        inQuote = null;
        let closeBracket = -1;
        for (let i = openBracket + 1; i < out.length; i++) {
            const ch = out[i];
            if (inQuote) {
                if (ch === inQuote && !isEscaped(out, i)) inQuote = null;
                continue;
            }
            if (ch === "'" || ch === '"') { inQuote = ch; continue; }
            if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) { closeBracket = i; break; }
            }
        }
        if (closeBracket === -1) break;

        const inner = out.slice(openBracket + 1, closeBracket);
        // Recursively normalize inner elements if nested brackets contain =>
        const entries = splitTopLevelCommas(inner);
        let posIdx = 0;
        const jsEntries = entries.map((entry) => {
            const arrowPos = findTopLevelArrow(entry);
            if (arrowPos !== -1) {
                const k = entry.slice(0, arrowPos).trim();
                const v = convertPhpAssocArrays(entry.slice(arrowPos + 2).trim());
                return `${k}: ${v}`;
            }
            const idxKey = posIdx++;
            return `${idxKey}: ${convertPhpAssocArrays(entry)}`;
        });

        out = out.slice(0, openBracket) + '{ ' + jsEntries.join(', ') + ' }' + out.slice(closeBracket + 1);
    }
    return out;
}

/**
 * Convert PHP match(...) { ... } blocks to JS arrow IIFE / ternary using __JS_ARROW__ marker
 * so convertPhpAssocArrays never corrupts JS arrow syntax.
 */
function convertPhpMatchBlocks(code) {
    let out = code;
    let safety = 0;
    while (safety++ < 100) {
        const idxSp = out.search(/\bmatch\s*\(/);
        if (idxSp === -1) break;
        const m = out.slice(idxSp).match(/^match\s*\(/);
        if (!m) break;
        const openParen = idxSp + m[0].length - 1;
        const closeParen = findMatchingParen(out, openParen);
        if (closeParen === -1) break;
        const subject = out.slice(openParen + 1, closeParen).trim();
        let braceStart = closeParen + 1;
        while (braceStart < out.length && /\s/.test(out[braceStart])) braceStart++;
        if (out[braceStart] !== '{') break;
        let depth = 1;
        let inQuote = null;
        let braceEnd = -1;
        for (let i = braceStart + 1; i < out.length; i++) {
            const ch = out[i];
            if (inQuote) {
                if (ch === inQuote && !isEscaped(out, i)) inQuote = null;
                continue;
            }
            if (ch === "'" || ch === '"') { inQuote = ch; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { braceEnd = i; break; }
            }
        }
        if (braceEnd === -1) break;
        const body = out.slice(braceStart + 1, braceEnd);

        const arms = splitTopLevelCommas(body);
        const jsCases = [];
        let defaultExpr = 'null';
        for (const arm of arms) {
            const arrowPos = findTopLevelArrow(arm);
            if (arrowPos === -1) continue;
            const cond = arm.slice(0, arrowPos).trim();
            const val = arm.slice(arrowPos + 2).trim();
            if (cond === 'default') {
                defaultExpr = val;
            } else {
                jsCases.push({ cond, val });
            }
        }

        let expr;
        if (subject === 'true') {
            expr = '(' + jsCases.map((c) => `(${c.cond}) ? (${c.val})`).join(' : ') + ` : (${defaultExpr}))`;
        } else {
            expr = `((__v) __JS_ARROW__ { ${jsCases.map((c) => `if (${splitTopLevelCommas(c.cond).map((k) => `__v === ${k}`).join(' || ')}) return (${c.val});`).join(' ')} return (${defaultExpr}); })(${subject})`;
        }

        out = out.slice(0, idxSp) + expr + out.slice(braceEnd + 1);
    }
    return out;
}

function stripDollarVars(code) {
    let out = '';
    let inQuote = null;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (inQuote) {
            out += ch;
            if (ch === inQuote && !isEscaped(code, i)) inQuote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            inQuote = ch;
            out += ch;
            continue;
        }
        if (ch === '$' && /[a-zA-Z_]/.test(code[i + 1] || '')) {
            continue;
        }
        out += ch;
    }
    return out;
}

function convertPhpElvis(code) {
    let out = '';
    let inQuote = null;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (inQuote) {
            out += ch;
            if (ch === inQuote && !isEscaped(code, i)) inQuote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            inQuote = ch;
            out += ch;
            continue;
        }
        // Replace PHP Elvis `?:` outside strings and not regex `(?:...)`
        if (ch === '?' && code[i + 1] === ':' && (i === 0 || code[i - 1] !== '(')) {
            out += '||';
            i++;
            continue;
        }
        out += ch;
    }
    return out;
}

function convertPhpConcatDot(code) {
    let out = '';
    let inQuote = null;
    for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (inQuote) {
            out += ch;
            if (ch === inQuote && !isEscaped(code, i)) inQuote = null;
            continue;
        }
        if (ch === "'" || ch === '"') {
            inQuote = ch;
            out += ch;
            continue;
        }
        if (ch === '.') {
            const left = code[i - 1] || '';
            const right = code[i + 1] || '';
            if (code.slice(i, i + 3) === '...') {
                out += '...';
                i += 2;
                continue;
            }
            const isConcat =
                (/\s/.test(left) && /\s/.test(right)) ||
                ((left === "'" || left === '"' || left === ')') && /\s/.test(right)) ||
                (/\s/.test(left) && (right === "'" || right === '"'));
            if (isConcat) {
                out += ' + ';
                continue;
            }
        }
        out += ch;
    }
    return out;
}

/**
 * Convert PHP expressions inside {{ ... }}, @if(...), @php ... @endphp, etc. to valid JS.
 */
function phpExprToJs(raw) {
    let s = String(raw || '').trim();
    if (!s) return s;

    // 1. Convert match(...) { ... } blocks BEFORE assoc arrays
    s = convertPhpMatchBlocks(s);

    // 2. Auth / Request / Session / Route / Laravel facades
    s = s.replace(/\\?Illuminate\\Support\\Facades\\Auth::user\(\)/g, 'authUser');
    s = s.replace(/\\?Illuminate\\Support\\Facades\\Auth::check\(\)/g, 'Boolean(authUser)');
    s = s.replace(/\\?Illuminate\\Support\\Facades\\Auth::id\(\)/g, '(authUser?.id ?? null)');
    s = s.replace(/\\?Auth::user\(\)/g, 'authUser');
    s = s.replace(/\\?Auth::check\(\)/g, 'Boolean(authUser)');
    s = s.replace(/\\?Auth::id\(\)/g, '(authUser?.id ?? null)');
    s = s.replace(/\bauth\(\)->user\(\)/g, 'authUser');
    s = s.replace(/\bauth\(\)->check\(\)/g, 'Boolean(authUser)');
    s = s.replace(/\bauth\(\)->id\(\)/g, '(authUser?.id ?? null)');
    s = s.replace(/\bauth\(\)->id\b/g, '(authUser?.id ?? null)');

    s = s.replace(/\\?App\\Providers\\AppServiceProvider::versionedAsset\(/g, 'versionedAsset(');
    s = s.replace(/\\?App\\Services\\StoredFileService::settingImageUrl\(/g, 'settingImageUrl(');
    s = s.replace(/\\?App\\Models\\CommunityConcern::statuses\(\)/g, 'concernStatuses');
    s = s.replace(/\\?Route::currentRouteName\(\)/g, 'currentRoute');
    s = s.replace(/\\?Route::is\(/g, 'routeIs(');
    s = s.replace(/\\?Str::limit\(/g, 'strLimit(');
    s = s.replace(/\\?Carbon\\Carbon::now\(\)/g, 'new Date()');
    s = s.replace(/\\?Carbon\\Carbon::parse\(/g, 'new Date(');
    s = s.replace(/\bnow\(\)/g, 'new Date()');
    s = s.replace(/\bapp\(\)->environment\(\)/g, 'appEnvLabel');
    s = s.replace(/\bapp\(\)->version\(\)/g, 'appVersionLabel');
    s = s.replace(/\bphpversion\(\)/g, 'runtimeVersionLabel');

    // View::hasSection('page_title') ? $__env->yieldContent('page_title') : $currentPageTitle
    s = s.replace(/View::hasSection\('page_title'\)\s*\?\s*\$__env->yieldContent\('page_title'\)\s*:\s*\$currentPageTitle/g, 'typeof pageTitle !== "undefined" && pageTitle ? pageTitle : currentPageTitle');

    // request()->...
    s = s.replace(/request\(\)->fullUrlWithQuery\(/g, 'fullUrlWithQuery(');
    s = s.replace(/request\(\)->filled\(/g, 'requestFilled(');
    s = s.replace(/request\(\)->has\(/g, 'requestHas(');
    s = s.replace(/request\(\)->input\(/g, 'request(');

    // session()->... / session(...)
    s = s.replace(/session\(\)->has\(/g, 'sessionHas(');
    s = s.replace(/session\(\)->get\(/g, 'sessionGet(');
    s = s.replace(/(?<![.\w])session\(/g, 'sessionGet(');

    // Errors object
    s = s.replace(/\$errors->any\(\)/g, 'errors.any()');
    s = s.replace(/\$errors->all\(\)/g, 'errors.all()');
    s = s.replace(/\$errors->has\(/g, 'errors.has(');
    s = s.replace(/\$errors->first\(/g, 'errors.first(');

    // Strip leading $ from PHP variables (outside string literals)
    s = stripDollarVars(s);

    // Catch typehints: catch (\Throwable e) -> catch (e)
    s = s.replace(/\bcatch\s*\(\s*\\[A-Za-z_\\]+\s+([a-zA-Z_]\w*)\s*\)/g, 'catch ($1)');

    // PHP arrow -> and nullsafe ?->
    s = s.replace(/\?->/g, '?.');
    s = s.replace(/->/g, '.');

    // Type casts AFTER -> replacement so member chains / index chains / (expr) stay intact
    const exprChain = `((?:\\([^)]+\\)|[a-zA-Z_][a-zA-Z0-9_]*)(?:(?:\\?\\.|\\.)[a-zA-Z_][a-zA-Z0-9_]*|\\[[^\\]]+\\]|\\([^)]*\\))*)`;
    s = s.replace(new RegExp(`\\(\\s*(?:float|int|integer|double)\\s*\\)\\s*${exprChain}`, 'g'), 'Number($1)');
    s = s.replace(new RegExp(`\\(\\s*(?:string|str)\\s*\\)\\s*${exprChain}`, 'g'), 'String($1 ?? "")');
    s = s.replace(new RegExp(`\\(\\s*(?:bool|boolean)\\s*\\)\\s*${exprChain}`, 'g'), 'Boolean($1)');

    // PHP `foreach (...) {` inside @php blocks
    s = s.replace(/\bforeach\s*\(\s*([^)]+?)\s+as\s+(?:([a-zA-Z_]\w*)\s*=>\s*)?([a-zA-Z_]\w*)\s*\)\s*\{/g, (_, col, k, v) =>
        k ? `for (const [${k}, ${v}] of Object.entries(${col.trim()} || {})) {` : `for (const ${v} of (${col.trim()} || [])) {`
    );

    // PHP associative arrays ['k' => v] -> { 'k': v }
    s = convertPhpAssocArrays(s);

    // PHP `elseif` inside @php blocks (`}` is already before `elseif` in valid PHP)
    s = s.replace(/\belseif\s*\(/g, 'else if (');

    // Convert PHP standalone functions (negative lookbehind prevents matching .method())
    s = replaceBalancedCall(s, /(?<![.\w])str_contains\s*\(/g, (inner) => {
        const [hay, needle] = splitTopLevelCommas(inner);
        return `String(${hay} ?? '').includes(${needle})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])str_starts_with\s*\(/g, (inner) => {
        const [hay, needle] = splitTopLevelCommas(inner);
        return `String(${hay} ?? '').startsWith(${needle})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])str_ends_with\s*\(/g, (inner) => {
        const [hay, needle] = splitTopLevelCommas(inner);
        return `String(${hay} ?? '').endsWith(${needle})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])strtolower\s*\(/g, (inner) => `String(${inner} ?? '').toLowerCase()`);
    s = replaceBalancedCall(s, /(?<![.\w])strtoupper\s*\(/g, (inner) => `String(${inner} ?? '').toUpperCase()`);
    s = replaceBalancedCall(s, /(?<![.\w])trim\s*\(/g, (inner) => {
        const [str] = splitTopLevelCommas(inner);
        return `phpTrim(${str})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])substr\s*\(/g, (inner) => {
        const [str, start, len] = splitTopLevelCommas(inner);
        return len !== undefined ? `phpSubstr(${str}, ${start}, ${len})` : `phpSubstr(${str}, ${start})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])explode\s*\(/g, (inner) => {
        const [sep, str] = splitTopLevelCommas(inner);
        return `String(${str} ?? '').split(${sep})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])implode\s*\(/g, (inner) => {
        const [sep, arr] = splitTopLevelCommas(inner);
        return `(${arr} || []).join(${sep})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])in_array\s*\(/g, (inner) => {
        const [needle, hay] = splitTopLevelCommas(inner);
        return `(${hay} || []).includes(${needle})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])str_replace\s*\(/g, (inner) => {
        const [search, rep, subj] = splitTopLevelCommas(inner);
        return `String(${subj} ?? '').replaceAll(${search}, ${rep})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])number_format\s*\(/g, (inner) => `numberFormat(${inner})`);
    s = replaceBalancedCall(s, /(?<![.\w])filter_var\s*\(/g, (inner) => {
        const [val] = splitTopLevelCommas(inner);
        return `isValidUrl(${val})`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])isset\s*\(/g, (inner) => `(typeof ${inner} !== 'undefined' && ${inner} !== null)`);
    s = replaceBalancedCall(s, /(?<![.\w])empty\s*\(/g, (inner) => {
        const tr = inner.trim();
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tr)) {
            return `(typeof ${tr} === 'undefined' || !${tr} || (Array.isArray(${tr}) && ${tr}.length === 0))`;
        }
        return `(!(${inner}) || (Array.isArray(${inner}) && (${inner}).length === 0))`;
    });
    s = replaceBalancedCall(s, /(?<![.\w])count\s*\(/g, (inner) => `(${inner} ? ${inner}.length : 0)`);
    s = replaceBalancedCall(s, /(?<![.\w])is_string\s*\(/g, (inner) => `(typeof (${inner}) === 'string')`);
    s = replaceBalancedCall(s, /(?<![.\w])is_object\s*\(/g, (inner) => `(typeof (${inner}) === 'object' && (${inner}) !== null)`);
    s = replaceBalancedCall(s, /(?<![.\w])is_array\s*\(/g, (inner) => `Array.isArray(${inner})`);
    s = replaceBalancedCall(s, /(?<![.\w])date\s*\(/g, (inner) => {
        const args = splitTopLevelCommas(inner);
        if (args.length === 1) return `formatDate(new Date(), ${args[0]})`;
        return `formatDate(${args[1]}, ${args[0]})`;
    });
    s = s.replace(/\bstrtotime\s*\(\s*['"]\+1 day['"]\s*\)/g, 'tomorrowIso');
    s = s.replace(/formatDate\(\s*tomorrowIso\s*,\s*(['"]Y-m-d['"])\s*\)/g, 'tomorrowIso');
    s = s.replace(/formatDate\(\s*new Date\(\)\s*,\s*['"]Y['"]\s*\)/g, 'currentYear');
    s = s.replace(/formatDate\(\s*new Date\(\)\s*,\s*['"]Y-m-d['"]\s*\)/g, 'todayIso');

    // Method calls on dates / collections / strings (handle ?. and new Date(...) cleanly)
    s = replaceBalancedCall(s, /((?:new\s+Date\([^()]*(?:\([^()]*\)[^()]*)*\)|[a-zA-Z0-9_.]+))\??\.format\s*\(/g, (inner, m) => `formatDate(${m[1]}, ${inner})`);
    s = replaceBalancedCall(s, /((?:new\s+Date\([^()]*(?:\([^()]*\)[^()]*)*\)|[a-zA-Z0-9_.]+))\??\.diffInHours\s*\(/g, (_inner, m) => `diffInHours(${m[1]})`);
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.diffForHumans\(\)/g, 'diffForHumans($1)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.isPast\(\)/g, 'isPast($1)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.hasVerifiedEmail\(\)/g, 'Boolean($1?.email_verified_at)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.formattedAddress\(\)/g, '($1?.formatted_address || "")');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.count\(\)/g, '($1 ? $1.length : 0)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.isEmpty\(\)/g, '(!$1 || $1.length === 0)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.isNotEmpty\(\)/g, '(Boolean($1) && $1.length > 0)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.take\((\d+)\)\.values\(\)/g, '($1 || []).slice(0, $2)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.take\((\d+)\)/g, '($1 || []).slice(0, $2)');
    s = s.replace(/([a-zA-Z0-9_.]+)\??\.values\(\)/g, '($1 || [])');

    // PHP array append `$arr[] = $val;` -> `$arr.push($val);`
    s = s.replace(/([a-zA-Z_][a-zA-Z0-9_.\[\]]*)\[\]\s*=\s*([^;]+);/g, '$1.push($2);');

    // PHP Elvis `?:` -> `||`
    s = convertPhpElvis(s);

    // String concatenation `.` -> `+`
    s = convertPhpConcatDot(s);

    // Restore JS arrow functions emitted by convertPhpMatchBlocks
    s = s.replace(/__JS_ARROW__/g, '=>');

    return s;
}

function convertPhpBlock(rawPhp) {
    const js = phpExprToJs(rawPhp);
    const lines = js.split(/\r?\n/);
    const declared = new Set();
    return lines
        .map((line) => {
            const trimmed = line.trim();
            const assignMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?!=)/);
            if (assignMatch && !['let', 'const', 'var', 'if', 'else', 'for', 'while', 'return', 'switch'].includes(assignMatch[1])) {
                const name = assignMatch[1];
                if (!declared.has(name)) {
                    declared.add(name);
                    return line.replace(new RegExp(`\\b${name}\\s*=`), `var ${name} =`);
                }
            }
            return line;
        })
        .join('\n');
}

function convertDirectiveWithBalancedArgs(src, directive, handler) {
    let out = src;
    const regex = new RegExp(`@${directive}\\s*\\(`, 'g');
    let safety = 0;
    while (safety++ < 1000) {
        regex.lastIndex = 0;
        const m = regex.exec(out);
        if (!m) break;
        const openIdx = m.index + m[0].length - 1;
        const closeIdx = findMatchingParen(out, openIdx);
        if (closeIdx === -1) break;
        const inner = out.slice(openIdx + 1, closeIdx);
        const replacement = handler(inner, m);
        out = out.slice(0, m.index) + replacement + out.slice(closeIdx + 1);
    }
    return out;
}

const ADMIN_SUPABASE_REALTIME_SCRIPT = `    /* ─── Real-time Supabase Broadcast Client Connection ─── */
    </script>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
    <script>
    (function initRealtimeWebSocket() {
        const realtimeCfg = <%- JSON.stringify(typeof realtimeConfig !== 'undefined' ? realtimeConfig : null) %>;
        if (!realtimeCfg || !realtimeCfg.url || !realtimeCfg.anonKey || !realtimeCfg.channel || !window.supabase) {
            return;
        }

        try {
            const sbClient = window.supabase.createClient(realtimeCfg.url, realtimeCfg.anonKey, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const channel = sbClient.channel(realtimeCfg.channel);

            channel.on('broadcast', { event: 'ebarangay_event' }, function (msg) {
                try {
                    const payload = msg && msg.payload ? msg.payload : msg;
                    if (!payload || !payload.event) return;

                    console.log('📡 Real-time Supabase event received:', payload);
                    document.dispatchEvent(new CustomEvent('admin:realtime-event', { detail: payload }));

                    if (payload.event === 'request.created') {
                        const d = payload.data || {};
                        if (window.agToast) {
                            window.agToast(
                                'New Document Request',
                                d.message || \`Request #\${d.tracking_number} received from \${d.applicant || 'Resident'}\`,
                                'info',
                                6000
                            );
                        }
                    } else if (payload.event === 'request.status_changed') {
                        const d = payload.data || {};
                        const type = d.status === 'Rejected' ? 'danger' : (d.status === 'Ready' ? 'success' : 'info');
                        if (window.agToast) {
                            window.agToast(
                                'Request Status Updated',
                                d.message || \`Request #\${d.tracking_number} is now \${d.status}\`,
                                type,
                                5000
                            );
                        }
                    }

                    if (typeof window.fetchAdminNotifications === 'function') {
                        window.fetchAdminNotifications();
                    }
                } catch (e) {
                    console.error('Error handling Supabase realtime message:', e);
                }
            });

            channel.subscribe(function (status) {
                if (status === 'SUBSCRIBED') {
                    console.log('⚡ Connected to e-Barangay Supabase Realtime');
                    document.dispatchEvent(new CustomEvent('admin:ws-connected'));
                    const liveIndicator = document.getElementById('live-status-indicator');
                    if (liveIndicator) {
                        liveIndicator.classList.remove('offline');
                        liveIndicator.title = 'Real-time updates active';
                    }
                } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    document.dispatchEvent(new CustomEvent('admin:ws-disconnected'));
                }
            });
        } catch (err) {
            console.warn('Supabase realtime init skipped:', err && err.message);
        }
    })();
    </script>`;

const RESIDENT_SUPABASE_REALTIME_SCRIPT = `    {{-- Real-Time Supabase Broadcast Client Connection --}}
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
    <script>
    (function initResidentWebSocket() {
        const currentUserId = <%= Boolean(authUser) ? Number(authUser.id) : 'null' %>;
        const realtimeCfg = <%- JSON.stringify(typeof realtimeConfig !== 'undefined' ? realtimeConfig : null) %>;
        if (!realtimeCfg || !realtimeCfg.url || !realtimeCfg.anonKey || !realtimeCfg.channel || !window.supabase) {
            return;
        }

        try {
            const sbClient = window.supabase.createClient(realtimeCfg.url, realtimeCfg.anonKey, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const channel = sbClient.channel(realtimeCfg.channel);

            channel.on('broadcast', { event: 'ebarangay_event' }, function (msg) {
                try {
                    const payload = msg && msg.payload ? msg.payload : msg;
                    if (!payload || !payload.event) return;

                    console.log('📡 Real-time Supabase event received:', payload);
                    document.dispatchEvent(new CustomEvent('resident:realtime-event', { detail: payload }));

                    if (payload.event === 'request.status_changed') {
                        const d = payload.data || {};
                        if (d.user_id && currentUserId && Number(d.user_id) !== currentUserId) {
                            return;
                        }

                        const type = d.status === 'Rejected' ? 'danger' : (d.status === 'Ready' || d.status === 'Completed' ? 'success' : 'info');

                        if (window.agToast) {
                            window.agToast(
                                \`Request #\${d.tracking_number} Updated\`,
                                d.message || \`Your document request is now \${d.status}.\`,
                                type,
                                6000
                            );
                        }

                        if (typeof window.fetchResidentNotifications === 'function') {
                            window.fetchResidentNotifications(true);
                        }

                        const trBadge = document.getElementById('rTrackRequestsBadge');
                        if (trBadge) {
                            fetch("<%= route('resident.requests.check') %>")
                                .then(r => r.json())
                                .then(res => {
                                    if (res && res.active_count !== undefined) {
                                        trBadge.textContent = res.active_count;
                                        if (res.active_count > 0) {
                                            trBadge.classList.remove('d-none');
                                        } else {
                                            trBadge.classList.add('d-none');
                                        }
                                    }
                                })
                                .catch(() => {});
                        }
                    }
                } catch (e) {
                    console.error('Error handling Supabase realtime message:', e);
                }
            });

            channel.subscribe(function (status) {
                if (status === 'SUBSCRIBED') {
                    console.log('⚡ Resident Connected to e-Barangay Supabase Realtime');
                    document.dispatchEvent(new CustomEvent('resident:ws-connected'));
                } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    document.dispatchEvent(new CustomEvent('resident:ws-disconnected'));
                }
            });
        } catch (err) {
            console.warn('Supabase realtime init skipped:', err && err.message);
        }
    })();
    </script>`;

function preNormalizeView(src, normRel) {
    let out = src;

    if (normRel === 'welcome.blade.php') {
        out = out.replace(
            /@php\s*\$navUser\s*=\s*auth\(\)->user\(\);[\s\S]*?\$navInitials[\s\S]*?@endphp/g,
            `<% const navUser = authUser; const isLoggedInResident = navUser && String(navUser.role || '').trim().toLowerCase() !== 'admin'; const navInitials = String(navUser?.name || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2).map(part => part.slice(0, 1).toUpperCase()).join(''); %>`
        );
        out = out.replace(/@php\s*\$portalDocs\s*=\s*collect\(\);[\s\S]*?@endphp/g, '');
        out = out.replace(/\$navUser->unreadNotifications->count\(\)/g, '$welcomeUnreadNotifCount');
        out = out.replace(/\$navUser->notifications->take\(8\)/g, '$welcomeNotifs');
    }

    if (normRel === 'resident/activity_logs.blade.php') {
        out = out.replace(
            /@php\s*preg_match\([\s\S]*?\$docRequest\s*=[\s\S]*?@endphp/g,
            '<% const docRequest = log.linked_request_id ? { id: log.linked_request_id } : null; %>'
        );
    }

    if (normRel === 'resident/track_request.blade.php') {
        out = out.replace(
            /\{\{\s*\\App\\Models\\DocumentRequest::where\('user_id',\s*auth\(\)->user\(\)->id\)->max\('updated_at'\)\s*\}\}/g,
            '<%= currentLastUpdate %>'
        );
        out = out.replace(
            /\{\{\s*\\App\\Models\\DocumentRequest::where\('user_id',\s*auth\(\)->user\(\)->id\)->count\(\)\s*\}\}/g,
            '<%= currentTotalCount %>'
        );
    }

    if (normRel === 'resident/request_document.blade.php') {
        out = out.replace(
            /\$docTypesList\s*=\s*collect\(\);[\s\S]*?Schema::hasTable\('document_types'\)[\s\S]*?DocumentType::active\(\)->orderBy\('name'\)->get\(\);[\s\S]*?catch\s*\(\\Throwable\s+\$e\)\s*\{[\s\S]*?\}/g,
            '$docTypesList = $activeDocTypes ?? [];'
        );
        out = out.replace(/\$docConfigMap\s*=\s*\[\s*\];/g, 'const docConfigMap = {};');
        out = out.replace(/\$docIconsMap\s*=\s*\[\s*\];/g, 'const docIconsMap = {};');
    }

    if (normRel === 'resident/dashboardresident.blade.php') {
        out = out.replace(/\$config\b/g, '$announcementConfig');
        out = out.replace(/\$request\b/g, '$reqItem');
    }

    if (normRel === 'resident/layouts/resident.blade.php') {
        out = out.replace(
            /\$residentActiveRequestsCount\s*=\s*0;\s*if\s*\(auth\(\)->check\(\)\)\s*\{\s*\$residentActiveRequestsCount\s*=\s*\\App\\Models\\DocumentRequest::where[\s\S]*?->count\(\);\s*\}/g,
            '// residentActiveRequestsCount precomputed by populateResidentLayoutLocals'
        );
        out = out.replace(
            /@php\s*\$unreadNotifCount\s*=\s*auth\(\)->check\(\)[\s\S]*?\$userNotifs\s*=[\s\S]*?@endphp/g,
            ''
        );
        out = out.replace(
            /let\s+currentUnreadCount\s*=\s*\{\{[^}]*unreadNotifications[^}]*\}\};/g,
            'let currentUnreadCount = <%= Number(unreadNotifCount || 0) %>;'
        );
        out = out.replace(
            /auth\(\)->user\(\)->notifications->first\(\)/g,
            '(userNotifs[0] ?? null)'
        );
        out = out.replace(
            /\{\{--\s*Real-Time WebSocket Client Connection\s*--\}\}\s*<script>[\s\S]*?initResidentWebSocket\(\)\s*\{[\s\S]*?<\/script>/g,
            RESIDENT_SUPABASE_REALTIME_SCRIPT
        );
    }

    if (normRel === 'admin/layouts/admin.blade.php') {
        out = out.replace(
            /\$pendingRequestsCount\s*=\s*\\App\\Models\\DocumentRequest::whereIn[\s\S]*?\$logoUrl\s*=[\s\S]*?cogon_east_logo\.png'\);/g,
            '// pending counts and logoUrl precomputed by populateAdminLayoutLocals'
        );
        out = out.replace(
            /\s*\/\*\s*─── Real-time WebSocket Client Connection ───\s*\*\/[\s\S]*?\(function\s+initRealtimeWebSocket\(\)\s*\{[\s\S]*?<\/script>/g,
            '\n' + ADMIN_SUPABASE_REALTIME_SCRIPT
        );
    }

    return out;
}

function convertBladeToEjs(src, relPath) {
    const normRel = relPath.replace(/\\/g, '/');
    let out = preNormalizeView(src, normRel);

    // 1. Remove @extends and @section('content') / @endsection wrapper
    out = out.replace(/@extends\s*\([^)]+\)\s*\r?\n?/g, '');
    out = out.replace(/@section\s*\(\s*['"]content['"]\s*\)\s*\r?\n?/g, '');
    out = out.replace(/@section\s*\(\s*['"]page_title['"]\s*,\s*(['"][^'"]+['"])\s*\)\s*\r?\n?/g, '<% var pageTitle = $1; %>\n');
    out = out.replace(/@endsection\s*/g, '');
    out = out.replace(/@yield\s*\(\s*['"]content['"]\s*\)/g, '<%- body %>');
    out = out.replace(/@yield\s*\(\s*['"]page_title['"]\s*,\s*(['"][^'"]+['"])\s*\)/g, '<%= typeof pageTitle !== "undefined" ? pageTitle : $1 %>');

    // 2. Blade comments
    out = out.replace(/\{\{--([\s\S]*?)--\}\}/g, '<%#$1%>');

    // 3. @csrf and @method
    out = out.replace(/@csrf\b/g, '<%- csrf_field() %>');
    out = convertDirectiveWithBalancedArgs(out, 'method', (inner) => `<%- method_field(${phpExprToJs(inner)}) %>`);

    // 4. @json(...)
    out = convertDirectiveWithBalancedArgs(out, 'json', (inner) => `<%- JSON.stringify(${phpExprToJs(inner)}) %>`);

    // 5. @include(...)
    out = convertDirectiveWithBalancedArgs(out, 'include', (inner) => {
        const parts = splitTopLevelCommas(inner);
        const viewName = parts[0].replace(/^['"]|['"]$/g, '').replace(/\./g, '/');
        const dataArg = parts[1] ? phpExprToJs(parts[1]) : '{}';
        return `<%- include('${viewName}', ${dataArg}) %>`;
    });

    // 6. @php ... @endphp
    out = out.replace(/@php\b([\s\S]*?)@endphp/g, (_, body) => `<%\n${convertPhpBlock(body)}\n%>`);

    // 7. Control structures with balanced parens
    out = convertDirectiveWithBalancedArgs(out, 'if', (inner) => `<% if (${phpExprToJs(inner)}) { %>`);
    out = convertDirectiveWithBalancedArgs(out, 'elseif', (inner) => `<% } else if (${phpExprToJs(inner)}) { %>`);
    out = out.replace(/@else\b/g, '<% } else { %>');
    out = out.replace(/@endif\b/g, '<% } %>');

    out = convertDirectiveWithBalancedArgs(out, 'error', (inner) => `<% if (errors.has(${phpExprToJs(inner)})) { var message = errors.first(${phpExprToJs(inner)}); %>`);
    out = out.replace(/@enderror\b/g, '<% } %>');

    // @foreach($items as $k => $v) or @foreach($items as $v)
    out = convertDirectiveWithBalancedArgs(out, 'foreach', (inner) => {
        const m = inner.match(/^([\s\S]+?)\s+as\s+(?:\$(\w+)\s*=>\s*)?\$(\w+)$/);
        if (!m) return `<% /* UNPARSED_FOREACH: ${inner} */ { %>`;
        const colExpr = phpExprToJs(m[1]);
        const keyVar = m[2];
        const valVar = m[3];
        if (keyVar) {
            return `<% for (const [${keyVar}, ${valVar}] of Object.entries(${colExpr} || {})) { %>`;
        }
        return `<% for (const ${valVar} of (${colExpr} || [])) { %>`;
    });
    out = out.replace(/@endforeach\b/g, '<% } %>');

    // @forelse($items as $v) ... @empty ... @endforelse
    const forelseRegex = /@forelse\s*\(|@empty\b|@endforelse\b/g;
    let res = '';
    let lastIdx = 0;
    const forelseStack = [];
    let counter = 0;
    while (true) {
        forelseRegex.lastIndex = lastIdx;
        const m = forelseRegex.exec(out);
        if (!m) {
            res += out.slice(lastIdx);
            break;
        }
        res += out.slice(lastIdx, m.index);
        if (m[0].startsWith('@forelse')) {
            const openIdx = m.index + m[0].length - 1;
            const closeIdx = findMatchingParen(out, openIdx);
            const inner = out.slice(openIdx + 1, closeIdx);
            const fm = inner.match(/^([\s\S]+?)\s+as\s+(?:\$(\w+)\s*=>\s*)?\$(\w+)$/);
            const arrVar = `__fl_${++counter}`;
            if (fm) {
                const colExpr = phpExprToJs(fm[1]);
                const valVar = fm[3];
                forelseStack.push({ arrVar });
                res += `<% const ${arrVar} = ${colExpr} || []; if (${arrVar}.length > 0) { for (const ${valVar} of ${arrVar}) { %>`;
            } else {
                forelseStack.push({ arrVar });
                res += `<% const ${arrVar} = []; if (${arrVar}.length > 0) { %>`;
            }
            lastIdx = closeIdx + 1;
        } else if (m[0] === '@empty') {
            res += `<% } } else { %>`;
            lastIdx = m.index + m[0].length;
        } else if (m[0] === '@endforelse') {
            forelseStack.pop();
            res += `<% } %>`;
            lastIdx = m.index + m[0].length;
        }
    }
    out = res;

    // @for($i = 0; $i < 5; $i++) ... @endfor
    out = convertDirectiveWithBalancedArgs(out, 'for', (inner) => {
        const js = phpExprToJs(inner).replace(/^([a-zA-Z_]\w*)\s*=/, 'let $1 =');
        return `<% for (${js}) { %>`;
    });
    out = out.replace(/@endfor\b/g, '<% } %>');

    // 8. Unescaped {!! expr !!}
    out = out.replace(/\{!!\s*([\s\S]*?)\s*!!\}/g, (_, expr) => `<%- ${phpExprToJs(expr)} %>`);

    // 9. Escaped {{ expr }}
    out = out.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expr) => `<%= ${phpExprToJs(expr)} %>`);

    // 10. Pagination links & root-relative partial includes
    out = out.replace(/<%=\s*(?:logs|allRequests)\.links\([^)]*\)\s*%>/g, '<%- renderPagination(paginator) %>');
    out = out.replace(/(?:logs|allRequests)\.hasPages\(\)/g, '(paginator && paginator.lastPage > 1)');
    out = out.replace(/(?:logs|allRequests)\.firstItem\(\)/g, '(paginator ? paginator.firstItem : 0)');
    out = out.replace(/(?:logs|allRequests)\.lastItem\(\)/g, '(paginator ? paginator.lastItem : 0)');
    out = out.replace(/(?:logs|allRequests)\.total\(\)/g, '(paginator ? paginator.total : 0)');
    out = out.replace(/include\('partials\//g, "include('/partials/");

    return out;
}

const files = walkBladeFiles(SRC_VIEWS);
let count = 0;
for (const file of files) {
    const rel = path.relative(SRC_VIEWS, file);
    const dstRel = rel.replace(/\.blade\.php$/, '.ejs');
    const dstPath = path.join(DST_VIEWS, dstRel);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    const src = fs.readFileSync(file, 'utf8');
    const converted = convertBladeToEjs(src, rel);
    fs.writeFileSync(dstPath, converted, 'utf8');
    count++;
}
console.log(`Converted ${count} Blade views to EJS in ${DST_VIEWS}`);
