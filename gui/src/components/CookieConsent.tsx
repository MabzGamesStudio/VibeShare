// The first-visit cookie choice: third-party embeds bring third-party tracking cookies,
// and the strictest compliance rules say nothing of the sort loads before the person
// chooses. Two equal buttons, no pre-chosen answer, scrolling is not consent, and the
// site is fully usable with embeds off.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { chooseConsent, doNotTrack, loadConsent, type EmbedConsent } from '../consent';
import { useApp } from '../state';

export function CookieConsent() {
  const { updateSettings } = useApp();
  const [record, setRecord] = useState(() => loadConsent());
  const [details, setDetails] = useState(false);
  const [show, setShow] = useState(() => loadConsent() === null);
  if (!show || record) return null;

  const choose = (choice: EmbedConsent) => {
    // The setting and the consent record move together: accept means embeds on, reject
    // means they stay off — and either can be changed later in Settings.
    chooseConsent(choice);
    setRecord(loadConsent());
    void updateSettings({ blockExternalEmbeds: choice !== 'accepted' });
  };

  return (
    <div className="cookie-consent" role="dialog" aria-label="Cookies and third-party embeds">
      <div className="cookie-consent-body">
        <strong>Cookies and third-party embeds</strong>
        <p className="small">
          Players and pictures from other platforms (YouTube, Vimeo, the Internet Archive, …) are <em>third-party embeds</em>: loading them lets those
          companies set <em>third-party tracking cookies</em> that follow you across sites. VibeShare itself stores only your choices and settings on
          this device, and nothing from other platforms loads until you decide.
        </p>
        {details && (
          <p className="small muted">
            <strong>What is stored:</strong> your choice here (on this device only, never sent anywhere) and your settings — both strictly necessary to
            run the app. <strong>What third parties get, if you allow embeds:</strong> their embedded player loads, and with it their cookies and
            tracking — that is the platform's doing, not VibeShare's. You can allow embeds now and still block them later (or the other way round) in{' '}
            <Link className="link" to="/settings#privacy">
              Settings → Privacy
            </Link>
            , where withdrawing is exactly as easy as choosing. {doNotTrack() && ' Your browser asks not to be tracked: embeds stay off until you explicitly allow them.'}
          </p>
        )}
        {doNotTrack() && !details && (
          <p className="small muted">Your browser sends a Do Not Track request: nothing is loaded until you say so.</p>
        )}
        <div className="row">
          <button className="small" onClick={() => choose('accepted')}>
            Allow third-party embeds
          </button>
          <button className="small" onClick={() => choose('rejected')}>
            Keep them off
          </button>
          <button className="small ghost" onClick={() => setDetails((on) => !on)}>
            {details ? 'Less' : 'What does this mean?'}
          </button>
        </div>
      </div>
    </div>
  );
}