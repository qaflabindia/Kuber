/**
 * Legacy migration (FIN-MIG-01..03, design 16.7): Tally, Zoho Books and CSV sources; inventory,
 * mapping and provenance; rehearsal, delta import and parallel-run comparison; signed go-live;
 * pre-cutover rollback and the post-cutover recovery procedure. See service.ts.
 */
export * from "./types.ts";
export { parseXml, decodeEntities, XmlError, XML_LIMITS, type XmlElement } from "./xml.ts";
export { parseTally, parseZoho, parseGenericCsv, parseSource, mergeExtracts, kindsOf, decodeUpload, strictPaise, strictDate, zohoKind, CSV_TEMPLATE_HEADER, MAX_FILE_CHARS, MAX_RECORDS } from "./adapters.ts";
export { suggestMappings, similarity, isSuspenseAccount, newAccountId, type Suggestion, type NewAccountSpec } from "./mapping.ts";
export { buildPlan, cutoffBalances, cutoffOpenItems, bookBalances, partyIdFor, type LoadPlan, type MappingRow, type Problem } from "./plan.ts";
export * from "./migrations.ts";
export { Migration, numbering, RECOVERY_PROCEDURE, REHEARSAL_POLICY, EXPLANATION_CATEGORIES, type MigrationDeps, type PartyPort, type CoverageSource, type BankCoverageSource, type ProjectRow, type LoadRow } from "./service.ts";
