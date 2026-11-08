import type { CiState, ReviewState } from "@kanbot/shared";
import { cn } from "@/lib/utils";

const CI: Record<CiState, { text: string; cls: string } | null> = {
  none: null,
  pending: { text: "CI running", cls: "bg-running text-running-fg" },
  passing: { text: "CI passed", cls: "bg-ok text-ok-fg" },
  failing: { text: "CI failed", cls: "bg-failed text-failed-fg" },
};
const REVIEW: Record<ReviewState, { text: string; cls: string } | null> = {
  none: null,
  approved: { text: "Approved", cls: "bg-ok text-ok-fg" },
  changes_requested: { text: "Changes requested", cls: "bg-needs text-needs-fg" },
};

/** A PR's CI and review state as GitHub last reported them (FR-46, FR-47); nothing for a ticket without a PR. */
export function PrStatus({ ci, review }: { ci: CiState; review: ReviewState }) {
  return [CI[ci], REVIEW[review]].map(
    (s) =>
      s && (
        <span key={s.text} className={cn("rounded-full px-2 py-0.5 text-xs", s.cls)}>
          {s.text}
        </span>
      ),
  );
}
