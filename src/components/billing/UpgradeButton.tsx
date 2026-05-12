import { useNavigate } from 'react-router-dom';
import { AuthButton } from '../auth/AuthButton';
import type { FeatureKey } from './planConfig';

interface UpgradeButtonProps {
  feature?: FeatureKey;
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  fullWidth?: boolean;
}

// Convenience CTA — routes to the tier-picker page. Pass `feature` to
// recommend the cheapest plan that unlocks it (the picker reads ?feature=).
export function UpgradeButton({
  feature,
  children = 'Upgrade',
  variant = 'primary',
  fullWidth,
}: UpgradeButtonProps) {
  const navigate = useNavigate();
  const href = feature ? `/upgrade?feature=${encodeURIComponent(feature)}` : '/upgrade';
  return (
    <AuthButton variant={variant} fullWidth={fullWidth} onClick={() => navigate(href)}>
      {children}
    </AuthButton>
  );
}
