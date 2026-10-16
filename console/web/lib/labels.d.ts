// Types for labels.js (the Replay Theater imports it from TypeScript). Keep in step with labels.js.
export interface Meaning { short: string; long: string }
export const GLOSSARY: Record<string, Meaning>;
export const STAGES: Record<string, Meaning>;
export const HYPOTHESES: Record<string, Meaning>;
export const DETECTORS: Record<string, Meaning>;
export const OUTCOME_LABEL: Record<string, string>;
export function plainCondition(V?: string | null, S?: string | null, W?: string | null): string;
export function conditionTitle(V?: string | null, S?: string | null, W?: string | null): string;
export function conditionCode(V?: string | null, S?: string | null, W?: string | null): string;
export function parseCell(cell: string): { ticket: string; V: string; S: string; W: string; unit: string };
export function outcomeLabel(o: string | null | undefined): string;
export function ticketLabel(code: string | null | undefined): string;
export function ticketPhrase(code: string | null | undefined): string;
export function stageLabel(code: string | null | undefined): string;
export function hypothesisLabel(code: string | null | undefined): string;
export function detectorLabel(code: string | null | undefined): string;
export function meaningOf(code: string | null | undefined): string;
export function withCode(code: string | null | undefined, label?: string | null): string;
export function runName(runId: string | null | undefined): string;
export const VISIBLE_CODE_RE: RegExp;
export function plainText<T extends string | null | undefined>(s: T): T;
export const LEGEND: { title: string; codes: string[]; items: { code: string; short: string; long: string }[] }[];
