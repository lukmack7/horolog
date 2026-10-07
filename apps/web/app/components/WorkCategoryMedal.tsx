"use client";

import { cn } from "@/lib/utils";
import {
  WORK_CATEGORY_LABEL,
  type WorkCategory,
} from "@/app/lib/api";

const SHORT: Record<WorkCategory, string> = {
  cmr: "C",
  macheta_data: "M",
  private: "P",
};

const STYLE: Record<WorkCategory, string> = {
  cmr: "bg-slate-600/10 text-slate-700 ring-slate-300/70",
  macheta_data: "bg-violet-600/10 text-violet-700 ring-violet-300/70",
  private: "bg-teal-600/10 text-teal-700 ring-teal-300/70",
};

export function WorkCategoryMedal({
  category,
  size = "sm",
  className,
}: {
  category?: WorkCategory | null;
  size?: "xs" | "sm";
  className?: string;
}) {
  if (!category) return null;

  return (
    <span
      title={WORK_CATEGORY_LABEL[category]}
      aria-label={WORK_CATEGORY_LABEL[category]}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-extrabold leading-none ring-1",
        STYLE[category],
        size === "xs" ? "h-4 w-4 text-[8px]" : "h-5 w-5 text-[9px]",
        className,
      )}
    >
      {SHORT[category]}
    </span>
  );
}
