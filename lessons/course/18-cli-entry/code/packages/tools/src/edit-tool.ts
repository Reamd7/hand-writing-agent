/**
 * Edit tool: precise text replacement in files.
 *
 * Supports multiple edits in a single call. Each edit's oldText is matched
 * against the original file content (not incrementally), validated for
 * uniqueness, checked for overlaps, and applied in reverse offset order.
 */

import * as Diff from "diff";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withFileMutationQueue } from "./file-mutation-queue.js";

// ── Types ────────────────────────────────────────────────────────────

export interface Edit {
  oldText: string;
  newText: string;
}

export interface EditToolInput {
  path: string;
  edits: Edit[];
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export interface EditResult {
  message: string;
  diff: string;
  firstChangedLine: number | undefined;
}

// ── Line ending utilities ────────────────────────────────────────────

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ── BOM handling ─────────────────────────────────────────────────────

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// ── Fuzzy matching ───────────────────────────────────────────────────

/**
 * Normalize text for fuzzy matching:
 * - NFKC normalization
 * - Strip trailing whitespace per line
 * - Smart quotes -> ASCII quotes
 * - Unicode dashes -> ASCII hyphen
 * - Special spaces -> regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

/**
 * Find oldText in content. Try exact match first, then fuzzy match.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // Exact match
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }

  // Fuzzy match
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }

  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

// ── Core edit application ────────────────────────────────────────────

/**
 * Apply edits to LF-normalized content.
 *
 * All edits are matched against the original content (not incrementally).
 * Replacements are applied in reverse offset order so indices stay stable.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  // Validate: no empty oldText
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      const label = normalizedEdits.length === 1 ? "oldText" : `edits[${i}].oldText`;
      throw new Error(`${label} must not be empty in ${path}.`);
    }
  }

  // Probe for fuzzy matches to decide working space
  const initialMatches = normalizedEdits.map((e) => fuzzyFindText(normalizedContent, e.oldText));
  const baseContent = initialMatches.some((m) => m.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  // Find all matches
  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const match = fuzzyFindText(baseContent, edit.oldText);

    if (!match.found) {
      const label = normalizedEdits.length === 1 ? "the exact text" : `edits[${i}]`;
      throw new Error(
        `Could not find ${label} in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      );
    }

    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) {
      const label = normalizedEdits.length === 1 ? "the text" : `edits[${i}]`;
      throw new Error(
        `Found ${occurrences} occurrences of ${label} in ${path}. The text must be unique. Please provide more context to make it unique.`,
      );
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: match.index,
      matchLength: match.matchLength,
      newText: edit.newText,
    });
  }

  // Sort by position and check for overlaps
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const prev = matchedEdits[i - 1];
    const curr = matchedEdits[i];
    if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
      throw new Error(
        `edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  // Apply in reverse order to preserve offsets
  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  // Verify something actually changed
  if (baseContent === newContent) {
    const label =
      normalizedEdits.length === 1
        ? "The replacement produced identical content."
        : "The replacements produced identical content.";
    throw new Error(`No changes made to ${path}. ${label}`);
  }

  return { baseContent, newContent };
}

// ── Diff generation ──────────────────────────────────────────────────

/**
 * Generate a human-readable diff with line numbers and context.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      // Context lines
      const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeading = lastWasChange;
      const hasTrailing = nextIsChange;

      if (hasLeading && hasTrailing) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          for (const line of raw.slice(0, contextLines)) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          const skipped = raw.length - contextLines * 2;
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
          for (const line of raw.slice(raw.length - contextLines)) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeading) {
        const shown = raw.slice(0, contextLines);
        for (const line of shown) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (raw.length > contextLines) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += raw.length - contextLines;
          newLineNum += raw.length - contextLines;
        }
      } else if (hasTrailing) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
        for (const line of raw.slice(skipped)) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

// ── prepareArguments compatibility shim ──────────────────────────────

/**
 * Normalize arguments from various LLM formats into the canonical form.
 *
 * Handles:
 * 1. JSON-string `edits` field (some models serialize arrays as strings)
 * 2. Legacy single-edit format with top-level `oldText`/`newText`
 */
export function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return input as EditToolInput;
  }

  const args = input as Record<string, unknown>;

  // Handle JSON-string edits
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      // leave as-is, validation will catch it
    }
  }

  // Handle legacy top-level oldText/newText
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits: Edit[] = Array.isArray(args.edits) ? [...(args.edits as Edit[])] : [];
    edits.push({ oldText: args.oldText as string, newText: args.newText as string });
    const { oldText: _o, newText: _n, ...rest } = args;
    return { ...rest, edits } as EditToolInput;
  }

  return args as unknown as EditToolInput;
}

// ── Path resolution ──────────────────────────────────────────────────

function resolveToCwd(path: string, cwd: string): string {
  if (resolve(path) === path) return path; // already absolute
  return resolve(cwd, path);
}

// ── Edit tool execute ────────────────────────────────────────────────

/**
 * Execute the edit tool: read file, apply edits, write back, return diff.
 */
export async function executeEdit(input: EditToolInput, cwd: string): Promise<EditResult> {
  const prepared = prepareEditArguments(input) as EditToolInput;

  if (!Array.isArray(prepared.edits) || prepared.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }

  const { path, edits } = prepared;
  const absolutePath = resolveToCwd(path, cwd);

  return withFileMutationQueue(absolutePath, async () => {
    // Check file is accessible
    await access(absolutePath, constants.R_OK | constants.W_OK);

    // Read
    const buffer = await readFile(absolutePath);
    const rawContent = buffer.toString("utf-8");

    // Normalize
    const { bom, text: content } = stripBom(rawContent);
    const originalEnding = detectLineEnding(content);
    const normalizedContent = normalizeToLF(content);

    // Apply edits
    const { baseContent, newContent } = applyEditsToNormalizedContent(
      normalizedContent,
      edits,
      path,
    );

    // Write back with original line endings and BOM
    const finalContent = bom + restoreLineEndings(newContent, originalEnding);
    await writeFile(absolutePath, finalContent, "utf-8");

    // Generate diff for display
    const diffResult = generateDiffString(baseContent, newContent);

    return {
      message: `Successfully replaced ${edits.length} block(s) in ${path}.`,
      diff: diffResult.diff,
      firstChangedLine: diffResult.firstChangedLine,
    };
  });
}
