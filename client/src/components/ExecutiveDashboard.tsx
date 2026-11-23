import BusinessMetricTiles from './BusinessMetricTiles';
import ChangeExposureBoard from './ChangeExposureBoard';
import FlowEfficiencyBoard from './FlowEfficiencyBoard';
import FlowScorecardBoard from './FlowScorecardBoard';

interface ExecutiveDashboardProps {
  onSelectDomain?: (domain: string) => void;
  onOpenFlow?: (flow: { diagramId: string; neighborhoodName: string | null }) => void;
  onOpenChangeRadar?: (flow: { diagramId: string; domain: string }) => void;
}

/**
 * "Dashboard" tab — a stack of at-a-glance executive widgets, each answering
 * its own "is everything OK, or do I need to act" question. Business measures
 * (one quantity-over-time tile per measure, Vehicles Sold included) lead,
 * then Throughput per cost (per flow, trend-tested), Process Flow Scorecards
 * (one multi-measure tile per flow) and the domain-level Change Exposure
 * Board. Add future widgets as further sections here rather than growing any
 * one widget to cover more ground.
 */
export default function ExecutiveDashboard({ onSelectDomain, onOpenFlow, onOpenChangeRadar }: ExecutiveDashboardProps) {
  return (
    <div className="h-full w-full overflow-y-auto bg-slate-50 p-5">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-5">
        <BusinessMetricTiles />
        <FlowEfficiencyBoard onOpenFlow={onOpenFlow} />
        <FlowScorecardBoard onOpenFlow={onOpenFlow} onOpenChangeRadar={onOpenChangeRadar} />
        <ChangeExposureBoard onSelectDomain={onSelectDomain} />
      </div>
    </div>
  );
}
