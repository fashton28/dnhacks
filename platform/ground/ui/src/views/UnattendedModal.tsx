/* UnattendedModal — the signed confirmation that enters unattended mode.
   Unattended entry is a SIGNED OPERATOR COMMAND (ADR D23): it never happens by
   losing the operator, by a timeout, or by anything the model emits. The
   operator types the confirmation phrase and their own id; both travel with
   the ordinary acked `enterUnattended` command, so the vehicle — not the
   ground station — decides whether to accept it.

   Exit is the opposite: it is automatic on operator connect, and the manual
   control here is only a shortcut to the same safe direction. */
import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { Modal, Button } from '@/components';
import { UNATTENDED_ENVELOPE } from '@/dataSource/scriptedRails';

/** The operator must type this exactly. Deliberately not a yes/no. */
export const UNATTENDED_CONFIRM_PHRASE = 'UNATTENDED';

export interface UnattendedModalProps {
  open: boolean;
  onClose: () => void;
  /** Sends `enterUnattended` with the typed operator id. */
  onConfirm: (operatorId: string) => void;
  /** Remembered operator id, if the session already has one. */
  defaultOperatorId?: string;
}

export function UnattendedModal({
  open, onClose, onConfirm, defaultOperatorId = '',
}: UnattendedModalProps): JSX.Element | null {
  const [operatorId, setOperatorId] = React.useState(defaultOperatorId);
  const [phrase, setPhrase] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setOperatorId(defaultOperatorId);
      setPhrase('');
    }
  }, [open, defaultOperatorId]);

  const idOk = operatorId.trim().length >= 3;
  const phraseOk = phrase.trim().toUpperCase() === UNATTENDED_CONFIRM_PHRASE;
  const ready = idOk && phraseOk;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Enter unattended mode"
      subtitle="Signed operator command — the vehicle flies with nobody on the loop."
      tone="caution"
      icon={<ShieldAlert size={16} />}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!ready}
            title={ready ? 'Send enterUnattended' : 'Type the confirmation phrase and your operator id'}
            onClick={() => { onConfirm(operatorId.trim()); onClose(); }}
          >
            Enter unattended mode
          </Button>
        </>
      }
    >
      <p style={{ margin: '0 0 10px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        While unattended, tasks are dispatched without an operator gate — but only inside
        the unattended envelope. Anything outside it is refused, and the refusal escalates.
      </p>

      <ul style={{
        margin: '0 0 14px', padding: '8px 10px 8px 24px',
        background: 'var(--amber-tint)', border: '1px solid var(--amber-line)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--text-xs)', color: 'var(--caution-fg)', lineHeight: 1.6,
      }}>
        <li>Inside the site perimeter only.</li>
        <li>Profile {UNATTENDED_ENVELOPE.profiles.join(' / ')} only.</li>
        <li>{UNATTENDED_ENVELOPE.altMinM}–{UNATTENDED_ENVELOPE.altMaxM} m AGL, {UNATTENDED_ENVELOPE.maxLaps} orbit lap, holds of {UNATTENDED_ENVELOPE.maxHoldS} s or less.</li>
        <li>No dispatch on degraded navigation, RF interference, a hostile drone, night without thermal, or wind above {UNATTENDED_ENVELOPE.maxWindMps} m/s.</li>
        <li>Reverts to attended automatically when an operator connects.</li>
      </ul>

      <Field label="Operator id">
        <input
          value={operatorId}
          onChange={(e) => setOperatorId(e.target.value)}
          placeholder="e.g. j.mokoena"
          autoComplete="off"
          style={inputStyle(idOk || operatorId.length === 0)}
        />
      </Field>

      <Field label={`Type ${UNATTENDED_CONFIRM_PHRASE} to confirm`}>
        <input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder={UNATTENDED_CONFIRM_PHRASE}
          autoComplete="off"
          style={{
            ...inputStyle(phraseOk || phrase.length === 0),
            fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          }}
        />
      </Field>

      <p style={{ margin: '4px 0 10px', fontSize: 'var(--text-2xs)', color: 'var(--text-disabled)', lineHeight: 1.5 }}>
        The operator id is recorded in the audit trail with the command. The companion
        independently refuses an unattended request it cannot verify.
      </p>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{
        display: 'block', marginBottom: 4,
        fontSize: 'var(--text-2xs)', fontWeight: 600, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: 'var(--text-tertiary)',
      }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function inputStyle(valid: boolean): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box',
    height: 'var(--control-h)',
    padding: '0 10px',
    background: 'var(--surface-input)',
    border: `1px solid ${valid ? 'var(--border-input)' : 'var(--red-line)'}`,
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-base)',
  };
}
