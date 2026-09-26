import ChangeExposureBoard from './ChangeExposureBoard';

interface ExecutiveDashboardProps {
  onSelectDomain?: (domain: string) => void;
}

/**
 * "Dashboard" tab — a stack of at-a-glance executive widgets, each answering
 * its own "is everything OK, or do I need to act" question. Change Exposure
 * Board is the first; add future widgets as further <section> blocks here
 * rather than growing any one widget to cover more ground.
 */
export default function ExecutiveDashboard({ onSelectDomain }: ExecutiveDashboardProps) {
  return (
    <div className="h-full w-full overflow-y-auto bg-slate-50 p-5">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
        <ChangeExposureBoard onSelectDomain={onSelectDomain} />
      </div>
    </div>
  );
}
