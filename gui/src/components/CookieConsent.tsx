// The first-visit cookie choice: third-party embeds bring third-party tracking cookies,
// and the strictest compliance rules say nothing of the sort loads before the person
// chooses. Two equal buttons, no pre-chosen answer, scrolling is not consent, and the
// site is fully usable with embeds off. The choice can also be made one platform at a
// time — the list below is the same one Settings → Privacy keeps editable.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { chooseConsent, choosePlatforms, doNotTrack, loadConsent, platformChoices, type EmbedConsent } from '../consent';
import { useApp } from '../state';

export function CookieConsent() {
  const { updateSettings } = useApp();
  const [details, setDetails] = useState(false);
  const [perPlatform, setPerPlatform] = useState(false);
  const [platforms, setPlatforms] = useState<Record<string, boolean>>(() => loadConsent()?.platforms ?? {});
  const [done, setDone] = useState(false);
  const [show] = useState(() => loadConsent() === null);
  if (!show || done) return null;

  const choose = (choice: EmbedConsent) => {
    // The setting and the consent record move together: accept means embeds on, reject
    // means they stay off — and either can be changed later in Settings.
    chooseConsent(choice);
    void updateSettings({ blockExternalEmbeds: choice !== 'accepted' });
    setDone(true);
  };

  const saveChoices = () => {
    // The platforms ticked here are allowed, the rest stay off (the strict default).
    choosePlatforms(platforms);
    void updateSettings({ blockExternalEmbeds: !Object.values(platforms).some(Boolean) });
    setDone(true);
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
            <Link className="link" to="/settings?tab=privacy">
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
          <button className="small ghost" onClick={() => setPerPlatform((on) => !on)}>
            {perPlatform ? 'Hide platforms' : 'Choose per platform'}
          </button>
          <button className="small ghost" onClick={() => setDetails((on) => !on)}>
            {details ? 'Less' : 'What does this mean?'}
          </button>
        </div>
        {perPlatform && (
          <div className="form-stack" style={{ marginTop: 8 }}>
            <p className="small muted">
              Only the platforms you tick here load their players, pictures and previews — everything else stays off. Every choice can be changed later
              in Settings → Privacy.
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {platformChoices().map((platform) => (
                <label key={platform.id} className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={platforms[platform.id] ?? false}
                    onChange={(e) => setPlatforms((current) => ({ ...current, [platform.id]: e.target.checked }))}
                  />
                  {platform.label}
                </label>
              ))}
            </div>
            <div className="row">
              <button
                className="small"
                onClick={() => setPlatforms(Object.fromEntries(platformChoices().map((platform) => [platform.id, true])))}
              >
                Allow all
              </button>
              <button
                className="small"
                onClick={() => setPlatforms(Object.fromEntries(platformChoices().map((platform) => [platform.id, false])))}
              >
                Deny all
              </button>
              <button className="primary small" onClick={saveChoices}>
                Save these choices
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
