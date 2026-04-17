
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { BottomPanel } from './BottomPanel';
import { WelcomeBanner } from './WelcomeBanner';
import { MapView } from '../map/MapView';

export function AppShell() {
  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <WelcomeBanner />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <MapView />
          <BottomPanel />
        </div>
      </div>
    </div>
  );
}
