import { useLocation } from 'react-router-dom';
import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature } from '../billing/planConfig';

/**
 * Whether the current user can use feed variants (A2). Agency+ only
 * (planConfig 'variants' key, distinct from the route-visibility 'scenarios'
 * key even though both gate to the same tier) — and always on /demo so the
 * feature is demoable to everyone. Kept in its own module so VariantSwitcher
 * stays a components-only file (react-refresh).
 */
export function useCanUseVariants(): boolean {
  const plan = useEditorPlan();
  const isDemo = useLocation().pathname.startsWith('/demo');
  return isDemo || planHasFeature(plan, 'variants');
}
