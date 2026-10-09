"use client";

import { AdhdTimePage } from "@/app/time/AdhdTimePage";
import { IS_ADHD_EXPERIENCE } from "@/app/lib/experience";

/**
 * Execution belongs to /time; the 15-minute calendar remains in Planner Day.
 * Reuse the same time-tracking APIs in both experiences without switching mode.
 */
export default function TimePage() {
  return <AdhdTimePage standard={!IS_ADHD_EXPERIENCE} />;
}
