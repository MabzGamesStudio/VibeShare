// The age-rating picker: a content can carry several age ratings at once — one per
// known rating system (MPA for the US, ClassInd for Brazil, …) plus any number of
// custom free-text "Other" ratings — shown as rows the operator removes or changes,
// with an "Add age rating system" button that appends a new one. Every row writes its
// age-rating topic into the topics list given (exactly one topic per known system, one
// per custom rating), and "Unknown" means no rating at all.
import { useState } from 'react';
import {
  AGE_RATING_SYSTEMS,
  OTHER_AGE_RATING_SYSTEM,
  UNKNOWN_AGE_RATING,
  type AgeRating,
  addAgeRatingTopic,
  ageRatingSystem,
  ageRatingTopic,
  parseAgeRatings,
  removeAgeRatingTopic,
} from '../../../src/shared/age-rating';

/** The system/category stand-ins for a free-text rating and for "no rating". */
const OTHER = OTHER_AGE_RATING_SYSTEM;

/** The first real category of a system — what a freshly picked system starts at. */
const firstCategoryOf = (systemId: string): string => ageRatingSystem(systemId)?.categories[0]?.slug ?? UNKNOWN_AGE_RATING;

function SystemSelect({ value, onChange }: { value: string; onChange: (systemId: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Rating system" style={{ maxWidth: 180 }}>
      <option value={UNKNOWN_AGE_RATING}>Unknown (default)</option>
      {AGE_RATING_SYSTEMS.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.label}
        </option>
      ))}
      <option value={OTHER}>Other (free text)</option>
    </select>
  );
}

function CategorySelect({ system, value, onChange }: { system: string; value: string; onChange: (categoryId: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Category" style={{ flex: 1 }}>
      {ageRatingSystem(system)?.categories.map((entry) => (
        <option key={entry.slug} value={entry.slug}>
          {entry.label}
        </option>
      ))}
      <option value={OTHER}>Other…</option>
    </select>
  );
}

export function AgeRatingPicker({ topics, onChange }: { topics: string[]; onChange: (topics: string[]) => void }) {
  const ratings = parseAgeRatings(topics);
  // The new row being added: its system is chosen first, then its category (or the
  // free text of an "Other" rating). "Unknown" simply drops the draft again.
  const [draft, setDraft] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const replace = (rating: AgeRating, topic: string | null) => {
    const dropped = removeAgeRatingTopic(topics, rating.system, rating.category);
    onChange(topic ? addAgeRatingTopic(dropped, topic) : dropped);
  };

  const setSystem = (rating: AgeRating, systemId: string) => {
    if (systemId === UNKNOWN_AGE_RATING) return replace(rating, null); // reset: no rating
    if (systemId === OTHER) {
      setOtherText((current) => ({ ...current, [`${rating.system}:${rating.category}`]: rating.category }));
      replace(rating, null);
      setDraft(OTHER);
      return;
    }
    replace(rating, ageRatingTopic(systemId, firstCategoryOf(systemId)));
  };

  const setCategory = (rating: AgeRating, categoryId: string) => {
    if (categoryId === OTHER) return setSystem(rating, OTHER);
    replace(rating, ageRatingTopic(rating.system, categoryId));
  };

  const setFreeText = (rating: AgeRating, text: string) => {
    setOtherText((current) => ({ ...current, [`${rating.system}:${rating.category}`]: text }));
    replace(rating, text.trim() ? ageRatingTopic(OTHER, text) : null);
  };

  const pickDraft = (systemId: string) => {
    if (systemId === UNKNOWN_AGE_RATING) return setDraft(null); // reset
    if (systemId === OTHER) return setDraft(OTHER);
    // A system starts at its first real category so the pick sticks as a real topic.
    onChange(addAgeRatingTopic(topics, ageRatingTopic(systemId, firstCategoryOf(systemId))));
    setDraft(null);
  };

  const commitDraft = () => {
    const text = draftText.trim();
    if (!text) return setDraft(null);
    onChange(addAgeRatingTopic(topics, ageRatingTopic(OTHER, text)));
    setDraftText('');
    setDraft(null);
  };

  return (
    <div className="form-stack">
      {ratings.map((rating, at) => (
        <div key={`${rating.system}:${at}`} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <SystemSelect value={rating.system} onChange={(systemId) => setSystem(rating, systemId)} />
          {rating.system === OTHER ? (
            <input
              type="text"
              value={otherText[`${rating.system}:${rating.category}`] ?? rating.category}
              onChange={(e) => setFreeText(rating, e.target.value)}
              placeholder="e.g. violence"
              aria-label="Rating (free text)"
              style={{ flex: 1 }}
            />
          ) : rating.system !== UNKNOWN_AGE_RATING ? (
            <CategorySelect system={rating.system} value={rating.category} onChange={(categoryId) => setCategory(rating, categoryId)} />
          ) : (
            <span className="hint" style={{ flex: 1, alignSelf: 'center' }}>
              No rating
            </span>
          )}
          <button
            type="button"
            className="small danger"
            title="Remove this rating"
            aria-label="Remove this rating"
            onClick={() => replace(rating, null)}
          >
            ×
          </button>
        </div>
      ))}
      {draft === null ? (
        <button type="button" className="small" onClick={() => setDraft('')}>
          + Add age rating system
        </button>
      ) : (
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <SystemSelect value={draft} onChange={pickDraft} />
          {draft === OTHER && (
            <input
              type="text"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitDraft();
              }}
              placeholder="e.g. violence — Enter to add"
              aria-label="Rating (free text)"
              style={{ flex: 1 }}
            />
          )}
          <button type="button" className="small" title="Cancel" aria-label="Cancel" onClick={() => setDraft(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
