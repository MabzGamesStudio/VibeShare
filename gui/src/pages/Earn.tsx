import { useState } from 'react';
import { AlgorithmJobsTab } from '../earn/AlgorithmJobsTab';
import { AlgorithmNodesTab } from '../earn/AlgorithmNodesTab';
import { ProviderJobsTab } from '../earn/ProviderJobsTab';
import { ProviderNodesTab } from '../earn/ProviderNodesTab';

const EARN_TABS = [
  ['algorithms', 'Algorithm nodes'],
  ['providers', 'Provider nodes'],
  ['provider-jobs', 'Provider jobs'],
  ['algorithm-jobs', 'Algorithm jobs'],
] as const;

type EarnTab = (typeof EARN_TABS)[number][0];

/** The earn page: what each kind of node pays for, and the jobs that earn it. */
export function EarnPage() {
  const [tab, setTab] = useState<EarnTab>('algorithms');
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