import { useLocation } from 'react-router-dom';
import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature } from '../billing/planConfig';

/**
 * Whether the current user can use feed variants (A2). Agency+ (the existing
 * planning gate, reusing the 'scenarios' feature) — and always on /demo so the
 * feature is demoable to everyone. Kept in its own module so VariantSwitcher
 * stays a components-only file (react-refresh).
 */
export function useCanUseVariants(): boolean {
  const plan = useEditorPlan();
  const isDemo = useLocation().pathname.startsWith('/demo');
  return isDemo || planHasFeature(plan, 'scenarios');
}
