import { AlertTriangle, KeyRound, ShieldAlert, Wallet } from 'lucide-react';

/**
 * What every crypto payment screen has to say, on the node side and in the client:
 * addresses only (never seeds or keys), an honest warning about this software, and the
 * reminder that a node never needs a large transfer.
 */
export function CryptoSafetyNotice({ compact }: { compact?: boolean }) {
  return (
    <div className="banner warn form-stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <KeyRound size={16} />
        <strong>Never enter a seed phrase or a private key</strong>
      </div>
      <span className="small">
        Nowhere in VibeShare needs one — this app only ever asks for <strong>public addresses</strong>. A seed phrase or private key here would
        give anyone who reads it full control of your funds, and no feature of this software requires it. If anything asks you for one, stop.
      </span>
      <div className="row" style={{ gap: 8 }}>
        <ShieldAlert size={16} />
        <strong>This software is vibe-coded: treat it as experimental</strong>
      </div>
      <span className="small">
        It was built quickly with AI assistance and may have vulnerabilities of any kind. Do not rely on it for anything you would mind losing,
        and audit it yourself if you need certainty.
      </span>
      <div className="row" style={{ gap: 8 }}>
        <Wallet size={16} />
        <strong>Never send a significant amount of crypto to a node operator</strong>
      </div>
      <span className="small">
        VibeShare is an open-source, free market: credits are cheap and large transfers are never needed. Pay only small amounts you can afford
        to lose, keep anything substantial in a wallet you control (ideally a hardware wallet), and use third-party wallets and explorers to
        make the transfer itself.
      </span>
      {!compact && (
        <span className="tiny faint row" style={{ gap: 6 }}>
          <AlertTriangle size={13} />
          Payments never happen inside the app: it only shows the operator's address and records the transfer you make with your own wallet.
        </span>
      )}
    </div>
  );
}
