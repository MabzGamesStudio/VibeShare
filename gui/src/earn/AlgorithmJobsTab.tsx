import { Clock, FileText, Flame, Sparkles, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PlatformEarningsTable } from './PlatformEarnings';

/**
 * The algorithm jobs tab: how the metadata jobs pay (reporting stats, corrections, new
 * content) and how to get the most credits out of them — popular content on platforms
 * and newer content on platforms earn the most.
 */
export function AlgorithmJobsTab() {
  return (
    <>
      <div className="card form-stack">
        <div className="row">
          <Sparkles size={22} />
          <div>
            <h2>Algorithm jobs: update content metadata for credits</h2>
            <p className="small muted">
              Algorithm nodes pay for what they did not know yet: platform numbers (views, likes, comments…), missing content ids and
              links, corrections to tags or creators. Two things decide what each job pays — how popular the content is on its platform
              and how new it is — so the jobs below are the ones worth doing first.
            </p>
          </div>
        </div>
      </div>

      <div className="card form-stack">
        <div className="row">
          <Flame size={22} />
          <div>
            <h2>Post stats of popular content</h2>
            <p className="small muted">
              The numbers the platform shows multiply the reward: a post with hundreds of thousands of views pays a multiple of what an
              unseen post pays. Chase what is currently popular on each platform — trending videos, top posts, viral shorts — and report
              the numbers the platform shows for them.
            </p>
          </div>
        </div>
        <ul className="small muted">
          <li>Report all the numbers, not just one: views, likes, comments, subscribers or upvotes, depending on the platform.</li>
          <li>The bigger the numbers, the bigger the multiplier the node applies to the base reward.</li>
          <li>Popular content on one platform earns on every node that rewards reports — spread it across your algorithm nodes.</li>
        </ul>
      </div>

      <div className="card form-stack">
        <div className="row">
          <Clock size={22} />
          <div>
            <h2>Post stats of newer content</h2>
            <p className="small muted">
              A recency factor multiplies the reward again: a post made today earns the most, and the factor decays back to 1× as the
              post gets older. Report fresh uploads and new posts early — and always fill in the post date, without it the recency
              multiplier cannot apply.
            </p>
          </div>
        </div>
        <ul className="small muted">
          <li>Newer content on platforms earns more than older content with the same numbers.</li>
          <li>Popular <strong>and</strong> new is the best combination: both multipliers stack.</li>
          <li>The post date is the publish date the platform shows — check it before sending.</li>
        </ul>
      </div>

      <div className="card form-stack">
        <div className="row">
          <TrendingUp size={22} />
          <div>
            <h2>Report again as the numbers grow</h2>
            <p className="small muted">
              Only new information is paid: once a node knows the numbers, the same report earns nothing. But numbers keep growing —
              reporting the same post again later, when the views or likes grew, is new information again and earns again. Revisiting
              yesterday's popular posts is one of the steadiest jobs there is.
            </p>
          </div>
        </div>
      </div>

      <div className="card form-stack">
        <div className="row">
          <FileText size={22} />
          <div>
            <h2>Give every job the full picture</h2>
            <p className="small muted">
              The node has to know which platform the numbers come from — every platform counts its own numbers. Use the source link of
              the post (platform + link), the post date and the numbers listed for that platform below.
            </p>
          </div>
        </div>
        <PlatformEarningsTable />
      </div>

      <div className="card form-stack">
        <div className="row">
          <Clock size={22} />
          <div>
            <h2>Pace, caps and accounts</h2>
            <p className="small muted">
              Rewards are capped per day and only new information pays, so steady beats spiky: a few popular and new posts every day
              earn more than a one-off flood of old ones. Some nodes only pay key-based accounts (see the algorithm nodes tab for what
              each of yours pays), and reports of content a node already has earn nothing — check what the node knows before reporting.
            </p>
          </div>
        </div>
      </div>

      <div className="card form-stack">
        <h2>Where to do the jobs</h2>
        <ul className="small muted">
          <li>
            <strong>Watch → Suggest → Report stats</strong> posts the platform numbers and the post date of the open content.
          </li>
          <li>
            <strong>Like / Dislike</strong> pays on nodes that reward the first vote on a piece of content.
          </li>
          <li>
            <strong>Suggest</strong> also reports missing source links and content ids (on provider nodes too), and corrections to
            tags, topics, format, age rating, creator or publish time — each with a reason and the timestamp that shows it.
          </li>
          <li>
            Content with missing data can be uploaded from a file or pulled from a URL in the same modal. Your review status per node is
            on <Link className="link" to="/earn">Earn → Algorithm nodes</Link>.
          </li>
        </ul>
      </div>
    </>
  );
}