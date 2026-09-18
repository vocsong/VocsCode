/**
 * Execution-outcome taxonomy for the reliability analytics: stable, low-cardinality names that
 * every classifier rule, aggregation and dashboard label agrees on. Raw facts are never expressed
 * in these terms; they are what the classifier derives from them (see classify.ts).
 */

/** Bumped when the shape of a stored execution record changes. */
export const ANALYTICS_SCHEMA_VERSION = 3;

/**
 * Bumped whenever a classification rule changes meaning. Stored on every record, so a chart can
 * say which rules produced its numbers and the store can reclassify old records from their raw facts.
 */
export const OUTCOME_CLASSIFIER_VERSION = 2;

/**
 * Coarse outcome of one execution. `failure` is the only class counted as an unexpected failure;
 * `informational` and `diagnostic` are non-zero exits that carry an answer rather than a mistake,
 * `control` is the user or a deadline intervening, `unknown` is a non-success the rules could not name.
 */
export type OutcomeClass = 'success' | 'informational' | 'diagnostic' | 'failure' | 'control' | 'unknown';

export const OUTCOME_CLASSES: OutcomeClass[] = ['success', 'informational', 'diagnostic', 'failure', 'control', 'unknown'];

export type ErrorCategory =
  // informational: the process reported a negative answer, as designed
  | 'search_no_match'
  | 'predicate_false'
  | 'differences_detected'
  | 'probe_negative'
  // diagnostic: the command ran and reported that the code under inspection has problems
  | 'test_failures_reported'
  | 'check_failures_reported'
  | 'build_failed'
  // model / agent
  | 'command_not_found'
  | 'wrong_shell_syntax'
  | 'malformed_syntax'
  | 'invalid_argument'
  | 'invalid_path'
  | 'malformed_patch'
  | 'edit_target_not_found'
  | 'incorrect_tool_usage'
  | 'invalid_tool_arguments'
  | 'unknown_tool_called'
  | 'program_error'
  // environment
  | 'missing_dependency'
  | 'permission_denied'
  | 'network_failure'
  | 'missing_credentials'
  | 'resource_exhaustion'
  | 'filesystem_failure'
  // repository state
  | 'vcs_state_conflict'
  | 'vcs_failure'
  // harness / infrastructure
  | 'tool_spawn_failure'
  | 'tool_transport_failure'
  | 'tool_unavailable'
  | 'shell_stderr_artifact'
  | 'subagent_failed'
  // control flow
  | 'timeout'
  | 'cancelled'
  | 'declined'
  | 'killed'
  | 'process_terminated'
  // unknown
  | 'process_nonzero_unknown'
  | 'unknown_failure'
  | 'legacy_unclassified';

/**
 * Who most plausibly caused the failure. `ambiguous` is a deliberate answer when the evidence
 * supports more than one party; `unknown` means the rules had nothing to go on.
 */
export type ErrorSource = 'model' | 'harness' | 'environment' | 'repository' | 'user' | 'external_service' | 'ambiguous' | 'unknown';

/** How a classification was reached, so heuristics are never mistaken for ground truth. */
export type ClassificationMethod = 'harness_signal' | 'exit_semantics' | 'stderr_signature' | 'heuristic' | 'unknown';

export type ClassificationConfidence = 'high' | 'medium' | 'low';

/** What was literally invoked, normalized across harness vocabularies. */
export type PhysicalTool = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'patch' | 'fetch' | 'agent' | 'mcp' | 'plan' | 'ask' | 'other';

/** What the agent was trying to do, whichever tool it used for it. */
export type LogicalOperation =
  | 'search'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'apply_patch'
  | 'inspect_repository'
  | 'execute_program'
  | 'run_tests'
  | 'check'
  | 'build'
  | 'install_dependency'
  | 'git_operation'
  | 'filesystem_operation'
  | 'network_operation'
  | 'environment_probe'
  | 'delegate'
  | 'mcp_call'
  | 'other';

export type ShellDialect = 'bash' | 'powershell' | 'cmd' | 'sh' | 'zsh' | 'fish' | 'unknown';

/** Default class of each category; the classifier may only tighten this, never contradict it. */
export const CATEGORY_CLASS: Record<ErrorCategory, OutcomeClass> = {
  search_no_match: 'informational',
  predicate_false: 'informational',
  differences_detected: 'informational',
  probe_negative: 'informational',
  test_failures_reported: 'diagnostic',
  check_failures_reported: 'diagnostic',
  build_failed: 'diagnostic',
  command_not_found: 'failure',
  wrong_shell_syntax: 'failure',
  malformed_syntax: 'failure',
  invalid_argument: 'failure',
  invalid_path: 'failure',
  malformed_patch: 'failure',
  edit_target_not_found: 'failure',
  incorrect_tool_usage: 'failure',
  invalid_tool_arguments: 'failure',
  unknown_tool_called: 'failure',
  program_error: 'failure',
  missing_dependency: 'failure',
  permission_denied: 'failure',
  network_failure: 'failure',
  missing_credentials: 'failure',
  resource_exhaustion: 'failure',
  filesystem_failure: 'failure',
  vcs_state_conflict: 'failure',
  vcs_failure: 'failure',
  tool_spawn_failure: 'failure',
  tool_transport_failure: 'failure',
  tool_unavailable: 'failure',
  shell_stderr_artifact: 'unknown',
  subagent_failed: 'failure',
  timeout: 'control',
  cancelled: 'control',
  declined: 'control',
  killed: 'control',
  process_terminated: 'control',
  process_nonzero_unknown: 'unknown',
  unknown_failure: 'unknown',
  legacy_unclassified: 'unknown'
};

/** Default source of each category; rules override it only with evidence (e.g. a known toolchain name). */
export const CATEGORY_SOURCE: Record<ErrorCategory, ErrorSource> = {
  search_no_match: 'model',
  predicate_false: 'model',
  differences_detected: 'model',
  probe_negative: 'model',
  test_failures_reported: 'repository',
  check_failures_reported: 'repository',
  build_failed: 'repository',
  command_not_found: 'ambiguous',
  wrong_shell_syntax: 'model',
  malformed_syntax: 'model',
  invalid_argument: 'model',
  invalid_path: 'model',
  malformed_patch: 'model',
  edit_target_not_found: 'model',
  incorrect_tool_usage: 'model',
  invalid_tool_arguments: 'model',
  unknown_tool_called: 'model',
  program_error: 'ambiguous',
  missing_dependency: 'environment',
  permission_denied: 'environment',
  network_failure: 'environment',
  missing_credentials: 'environment',
  resource_exhaustion: 'environment',
  filesystem_failure: 'environment',
  vcs_state_conflict: 'repository',
  vcs_failure: 'ambiguous',
  tool_spawn_failure: 'harness',
  tool_transport_failure: 'harness',
  tool_unavailable: 'harness',
  shell_stderr_artifact: 'harness',
  subagent_failed: 'ambiguous',
  timeout: 'ambiguous',
  cancelled: 'user',
  declined: 'user',
  killed: 'environment',
  process_terminated: 'unknown',
  process_nonzero_unknown: 'unknown',
  unknown_failure: 'unknown',
  legacy_unclassified: 'unknown'
};

/** Human labels for the dashboard; keys are the stable identifiers, these are free to change. */
export const CATEGORY_LABEL: Record<ErrorCategory, string> = {
  search_no_match: 'Search found nothing',
  predicate_false: 'Condition was false',
  differences_detected: 'Differences detected',
  probe_negative: 'Probe answered no',
  test_failures_reported: 'Tests reported failures',
  check_failures_reported: 'Type/lint check reported problems',
  build_failed: 'Build failed',
  command_not_found: 'Command not found',
  wrong_shell_syntax: 'Wrong shell dialect',
  malformed_syntax: 'Shell syntax error',
  invalid_argument: 'Invalid argument or option',
  invalid_path: 'Path does not exist',
  malformed_patch: 'Malformed patch',
  edit_target_not_found: 'Edit target not found',
  incorrect_tool_usage: 'Incorrect tool usage',
  invalid_tool_arguments: 'Invalid tool arguments',
  unknown_tool_called: 'Unknown tool called',
  program_error: 'Program raised an error',
  missing_dependency: 'Missing dependency or runtime',
  permission_denied: 'Permission denied',
  network_failure: 'Network failure',
  missing_credentials: 'Missing credentials',
  resource_exhaustion: 'Resource exhaustion',
  filesystem_failure: 'Filesystem failure',
  vcs_state_conflict: 'Git state conflict',
  vcs_failure: 'Git failure',
  tool_spawn_failure: 'Tool failed to start',
  tool_transport_failure: 'Tool transport failure',
  tool_unavailable: 'Tool unavailable',
  shell_stderr_artifact: 'Shell stderr artifact',
  subagent_failed: 'Subagent run failed',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
  declined: 'Declined',
  killed: 'Killed by signal',
  process_terminated: 'Process terminated',
  process_nonzero_unknown: 'Non-zero exit, unclassified',
  unknown_failure: 'Failure, unclassified',
  legacy_unclassified: 'Legacy record, not classifiable'
};

export const SOURCE_LABEL: Record<ErrorSource, string> = {
  model: 'Model',
  harness: 'Harness',
  environment: 'Environment',
  repository: 'Repository',
  user: 'User',
  external_service: 'External service',
  ambiguous: 'Ambiguous',
  unknown: 'Unknown'
};

export const OUTCOME_LABEL: Record<OutcomeClass, string> = {
  success: 'Success',
  informational: 'Informational non-zero',
  diagnostic: 'Diagnostic result',
  failure: 'Unexpected failure',
  control: 'Control flow',
  unknown: 'Unknown'
};

export const OPERATION_LABEL: Record<LogicalOperation, string> = {
  search: 'Search',
  read_file: 'Read file',
  write_file: 'Write file',
  edit_file: 'Edit file',
  apply_patch: 'Apply patch',
  inspect_repository: 'Inspect repository',
  execute_program: 'Execute program',
  run_tests: 'Run tests',
  check: 'Type/lint check',
  build: 'Build',
  install_dependency: 'Install dependency',
  git_operation: 'Git operation',
  filesystem_operation: 'Filesystem operation',
  network_operation: 'Network operation',
  environment_probe: 'Environment probe',
  delegate: 'Delegate to subagent',
  mcp_call: 'MCP call',
  other: 'Other'
};
