import type {
  AutomationConditions,
  AutomationFilterOptions,
  AutomationKind,
  TriggerNode,
  UnitSystem,
} from '@tracearr/shared';
import type { DescribeRefs } from '@/lib/automations';

/** What a row needs beyond its own node: the definition around it, and the names behind ids. */
export interface BuilderRefs {
  triggers: readonly TriggerNode[];
  kind: AutomationKind;
  /** The automation's own groups, which are the ones the engine rechecks a pause against. */
  conditions: AutomationConditions;
  filterOptions: AutomationFilterOptions | undefined;
  describe: DescribeRefs;
  unitSystem: UnitSystem;
}

/**
 * Which branches are open. The page owns it so jumping to a problem can open the
 * `if` that holds it before trying to focus a row Radix has not mounted.
 */
export interface BranchExpansion {
  isOpen: (ifId: string) => boolean;
  toggle: (ifId: string) => void;
}
