import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature } from '../billing/planConfig';

/**
 * Whether the current user can use feed variants (A2). Agency+ only
 * (planConfig 'variants' key, distinct from the route-visibility 'scenarios'
 * key even though both gate to the same tier). Gated everywhere, including
 * /demo, to match how 'scenarios' behaves (no demo bypass — anonymous/free
 * users must not see Variants). Kept in its own module so VariantSwitcher
 * stays a components-only file (react-refresh).
 */
export function useCanUseVariants(): boolean {
  const plan = useEditorPlan();
  return planHasFeature(plan, 'variants');
}
