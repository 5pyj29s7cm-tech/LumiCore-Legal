import { primaryTaskText, compact, capsuleTaskText } from './values';
import { OUTPUT_DESTINATION_RE, EXCLUDED_FILE_CLAUSE_RE, VALUE_CORRECTION_RE, ABSOLUTE_FILE_RE, POSIX_ABSOLUTE_FILE_RE, FILE_NAME_RE, FILE_EXTENSIONS, FILE_TASK_RE, FILE_ACTION_RE, WPS_RE, CURRENT_DOCUMENT_RE, IMPLICIT_CURRENT_DOCUMENT_RE, AUTHORING_APPLICATION_RE } from './recognition';
import { directorySearchReference, displayableFileName } from './paths';
import { actionInstructionClauses } from '../../cognition/action_instruction_clauses';
import { withoutLocationLiterals } from '../../cognition/location_literals';

/** Match instruction syntax while retaining the original source/destination spans. */
function outputDestination(text: string): { index: number; end: number; destination: string } | null {
  for (const clause of actionInstructionClauses(text)) {
    const syntax = withoutLocationLiterals(clause.probe, false, true);
    const match = OUTPUT_DESTINATION_RE.exec(syntax);
    if (!match) continue;
    // i18n-allow: A negated save/export/merge clause grants no destination.
    if (/(?:不要|别|禁止|无需|不用|不)\s*$|\b(?:do not|don't|without)\s*$/iu.test(syntax.slice(0, match.index))) continue;
    const end = clause.start + match.index + match[0].length;
    const destination = text.slice(end, clause.start + clause.text.length).split(/[\r\n，,；;。！？!?]/u)[0].trim();
    if (!ABSOLUTE_FILE_RE.test(destination) && !POSIX_ABSOLUTE_FILE_RE.test(destination) && !FILE_NAME_RE.test(destination)) continue;
    // English merge predicates precede their source operands; only the
    // destination complement separates those inputs from the result.
    const complementOffset = match[1] ? match[0].length - match[1].length : 0;
    return { index: clause.start + match.index + complementOffset, end, destination };
  }
  return null;
}

/** Read verification and target selection share the same input/output roles. */
export function sourceDocumentInstruction(text: string): string {
  const task = primaryTaskText(text);
  const destination = outputDestination(task);
  return destination ? task.slice(0, destination.index) : task;
}

/** Explicit save-as destination, separate from the referential input file. */
export function outputDocumentInstruction(text: string): string {
  return outputDestination(primaryTaskText(text))?.destination || '';
}

export function fileReferenceClauses(text: string): string[] {
  // Preserve punctuation boundaries so adjacent paths cannot merge.
  return primaryTaskText(text).split(/[\r\n，,；;。！？!?]/u);
}

export function excludedFileReferences(text: string): string[] {
  return fileReferenceClauses(text)
    .filter(clause => EXCLUDED_FILE_CLAUSE_RE.test(clause))
    .map(clause => explicitFile(clause, true))
    .filter(Boolean);
}

export function explicitFile(text: string, keepExcluded = false): string {
  const positive = keepExcluded ? primaryTaskText(text) : fileReferenceClauses(text)
    .filter(clause => !EXCLUDED_FILE_CLAUSE_RE.test(clause))
    .join('，');
  // In "edit that workbook, save as X", X is only the output. The input
  // remains referential and must be recovered from a trusted prior receipt.
  const destination = outputDestination(positive);
  let clean = destination ? positive.slice(0, destination.index) : positive;
  // A new output filename must not replace the already selected input when
  // the user adjusts a value and asks to generate the resulting file.
  if (VALUE_CORRECTION_RE.test(positive)) {
    // i18n-allow: Explicit artifact destination following a value correction.
    clean = clean.split(/(?:生成|创建|输出|新建)|\b(?:generate|create|write|output)\b/iu, 1)[0];
  }
  // i18n-allow: multilingual user target-correction recognition; not user-visible copy.
  const replacement = clean.match(/(?:而是|应该是|改成|换成|(?<!不)要用|请用|instead(?:\s+use)?|replace(?:\s+it)?\s+with)\s*([^\r\n，,；;。！？!?]{1,240})/iu)?.[1];
  // A value correction (quantity, price, date...) is not a target correction.
  // Only prefer the replacement clause when it actually names a file.
  // An output destination is not the value of the preceding quantity/price
  // correction, even when the user omitted punctuation between the clauses.
  // i18n-allow: output-destination input recognition.
  const replacementValue = replacement ? sourceDocumentInstruction(replacement) : undefined;
  const replacementNamesFile = replacementValue && (
    ABSOLUTE_FILE_RE.test(replacementValue) || POSIX_ABSOLUTE_FILE_RE.test(replacementValue)
    || FILE_NAME_RE.test(replacementValue)
  );
  const targetClause = compact(replacementNamesFile ? replacementValue : clean, 1500);
  const directorySearch = directorySearchReference(targetClause);
  if (directorySearch) return directorySearch.filename;
  // i18n-allow: multilingual explicit filename recognition; not user-visible copy.
  const named = targetClause.match(new RegExp(
    `(?:\u51c6\u786e\u6587\u4ef6\u540d\u662f|\u6587\u4ef6\u540d(?:\u79f0)?\u662f|\u53eb|\u540d\u4e3a|\u540d\u79f0\u662f|(?:exact\\s+)?file\\s*name\\s+is|named|called)\\s*["'“”‘’]?([^"'“”‘’\\r\\n，,；;。！？!?]{1,200}\\.${FILE_EXTENSIONS})`,
    'iu',
  ))?.[1];
  return compact(
    targetClause.match(ABSOLUTE_FILE_RE)?.[0]
      || targetClause.match(POSIX_ABSOLUTE_FILE_RE)?.[0]
      || named
      || targetClause.match(FILE_NAME_RE)?.[1],
    500,
  );
}

export function isFileTargetTask(text: string): boolean {
  const clean = `${primaryTaskText(text)} ${capsuleTaskText(text)}`.trim();
  return FILE_TASK_RE.test(clean) && FILE_ACTION_RE.test(clean);
}

export function prefersCurrentWpsDocument(text: string, applicationHint = ''): boolean {
  const clean = `${primaryTaskText(text)} ${capsuleTaskText(text)} ${compact(applicationHint, 160)}`;
  return WPS_RE.test(clean) && CURRENT_DOCUMENT_RE.test(clean);
}

export function prefersCurrentAuthoringDocument(text: string, applicationHint = ''): boolean {
  const task = `${primaryTaskText(text)} ${capsuleTaskText(text)}`;
  const clean = `${task} ${compact(applicationHint, 160)}`;
  return (CURRENT_DOCUMENT_RE.test(task) || IMPLICIT_CURRENT_DOCUMENT_RE.test(task))
    && (AUTHORING_APPLICATION_RE.test(clean) || IMPLICIT_CURRENT_DOCUMENT_RE.test(task));
}

export function explicitDirectory(pathValue: string): string {
  const clean = compact(pathValue, 500).replace(/[\\/]+$/, '');
  if (!clean) return '';
  if (displayableFileName(clean)) {
    const separatorIndex = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
    return separatorIndex > 1 ? clean.slice(0, separatorIndex) : '';
  }
  return clean;
}
