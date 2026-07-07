import type {
  Condition,
  RuleV2,
  Action,
  Session,
  ServerUser,
  Server,
  GroupEvidence,
} from '@tracearr/shared';

export interface EvaluationContext {
  session: Session;
  serverUser: ServerUser;
  server: Server;
  activeSessions: Session[];
  recentSessions: Session[];
  rule: RuleV2;
  /** All server_user ids belonging to the same identity as serverUser.
   *  Optional so contexts built before a lookup (or in old tests) fall back
   *  to single server_user behavior. */
  identityServerUserIds?: string[];
}

export interface EvaluatorResult {
  matched: boolean;
  actual: unknown;
  relatedSessionIds?: string[];
  details?: Record<string, unknown>;
}

export type ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
) => EvaluatorResult | Promise<EvaluatorResult>;

export type ActionExecutor = (context: EvaluationContext, action: Action) => void | Promise<void>;

export interface EvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  matchedGroups: number[];
  actions: Action[];
  evidence?: GroupEvidence[];
}
