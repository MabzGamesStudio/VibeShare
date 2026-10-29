import { claimSourceMetrics } from '../../../src/algorithm/metrics';
import { SOURCE_CATALOG } from '../../../src/algorithm/sources';

/**
 * Every platform's credit earning methods: the platform numbers *Report stats* takes
 * (views, likes, comments, subscribers, upvotes…). The same table backs the algorithm
 * nodes tab (what each node pays for) and the algorithm jobs tab (how to maximize it).
 */
export function PlatformEarningsTable() {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Platform</th>
          <th>Numbers to report with Report stats</th>
        </tr>
      </thead>
      <tbody>
        {SOURCE_CATALOG.map((source) => (
          <tr key={source.key}>
            <td className="small">{source.name}</td>
            <td className="small muted">{claimSourceMetrics(source.key).map((metric) => metric.label).join(' · ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}