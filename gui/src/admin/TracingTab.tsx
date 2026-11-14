// The Tracing tab of both node kinds: this node's local trace log, shown with the
// shared tracing view (the same widget the client uses) over this node's own
// /v1/admin/tracing endpoints. Recording itself stays off until the operator turns
// it on in Settings → Logging and tracing.
import { TracingView, traceApiOf } from '../components/Tracing';
import { admin } from './api';

// Built once at module scope: TracingView reloads its settings whenever the api
// reference changes, and a fresh object per render would undo that.
const tracing = traceApiOf(admin, '/v1/admin/tracing');

export function TracingTab() {
  return (
    <div className="form-stack">
      <div className="card form-stack">
        <h3>Tracing</h3>
        <p className="small muted">
          This node's local trace log — off by default; nothing is recorded until tracing is turned on in Settings → Logging and tracing.
        </p>
      </div>
      <TracingView api={tracing} />
    </div>
  );
}
