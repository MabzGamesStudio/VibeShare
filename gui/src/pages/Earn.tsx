import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlgorithmJobsTab } from '../earn/AlgorithmJobsTab';
import { AlgorithmNodesTab } from '../earn/AlgorithmNodesTab';
import { ProviderJobsTab } from '../earn/ProviderJobsTab';
import { ProviderNodesTab } from '../earn/ProviderNodesTab';

const EARN_TABS = [
  ['provider-jobs', 'Provider jobs'],
  ['algorithm-jobs', 'Algorithm jobs'],
  ['providers', 'Provider nodes'],
  ['algorithms', 'Algorithm nodes'],
] as const;

type EarnTab = (typeof EARN_TABS)[number][0];

/** The earn page: what each kind of node pays for, and the jobs that earn it. */
export function EarnPage() {
  // The tab lives in the URL (?tab=…), so cards elsewhere can link straight to one.
  const [params, setParams] = useSearchParams();
  const wanted = params.get('tab');
  const tab: EarnTab = EARN_TABS.some(([id]) => id === wanted) ? (wanted as EarnTab) : 'provider-jobs';
  const setTab = (id: EarnTab) => setParams({ tab: id });
  // ?card=… names the card to bring into view once the tab renders (the card's element
  // id is its name): the wizard links here to show a published job where it is listed.
  const card = params.get('card');
  useEffect(() => {
    if (!card) return;
    const timer = setTimeout(() => document.getElementById(card)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => clearTimeout(timer);
  }, [card, tab]);
  return (
    <div className="page page-narrow">
      <div className="page-header">
        <div>
          <h1>Earn credits</h1>
          <p>Nodes pay credits for services. Earned credits land on your account on that node.</p>
        </div>
      </div>

      <div className="tabs">
        {EARN_TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'algorithms' && <AlgorithmNodesTab />}
      {tab === 'providers' && <ProviderNodesTab />}
      {tab === 'provider-jobs' && <ProviderJobsTab />}
      {tab === 'algorithm-jobs' && <AlgorithmJobsTab />}
    </div>
  );
}