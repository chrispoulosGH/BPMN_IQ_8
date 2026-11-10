import ChangeExposureBoard from './ChangeExposureBoard';
import FlowScorecardBoard from './FlowScorecardBoard';

interface ExecutiveDashboardProps {
  onSelectDomain?: (domain: string) => void;
  onOpenFlow?: (flow: { diagramId: string; neighborhoodName: string | null }) => void;
  onOpenChangeRadar?: (flow: { diagramId: string; domain: string }) => void;
}

/**
 * "Dashboard" tab — a stack of at-a-glance executive widgets, each answering
 * its own "is everything OK, or do I need to act" question. Process Flow
 * Scorecards (one multi-measure tile per flow) leads; the domain-level
 * Change Exposure Board follows. Add future widgets as further sections here
 * rather than growing any one widget to cover more ground.
 */
export default function ExecutiveDashboard({ onSelectDomain, onOpenFlow, onOpenChangeRadar }: ExecutiveDashboardProps) {
  return (
    <div className="h-full w-full overflow-y-auto bg-slate-50 p-5">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-5">
        <FlowScorecardBoard onOpenFlow={onOpenFlow} onOpenChangeRadar={onOpenChangeRadar} />
        <ChangeExposureBoard onSelectDomain={onSelectDomain} />
      </div>
    </div>
  );
}
