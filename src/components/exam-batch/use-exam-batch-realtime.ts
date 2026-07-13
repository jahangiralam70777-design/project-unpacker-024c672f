// Exam Batch realtime bridge — mounted once inside ExamBatchLayout so that
// both admin and student subtrees receive live updates from Supabase
// postgres_changes.
//
// Invalidations are *scoped per table* so a single MCQ upload does not
// force sessions / enrollments / settings / analytics to refetch across
// every mounted admin screen. Query keys follow the convention
// ["exam-batch", "admin", <scope>, ...] and ["exam-batch", "student", ...];
// each realtime scope invalidates only its buckets.

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Map every realtime table to the query-key buckets it can affect.
// Only these buckets refetch on a burst — everything else stays cached.
const TABLE_SCOPES: Record<string, string[][]> = {
  exam_batch_settings: [
    ["exam-batch", "admin", "settings"],
    ["exam-batch", "admin", "attendance", "settings"],
    ["exam-batch", "public-settings"],
  ],
  exam_batch_sessions: [
    ["exam-batch", "admin", "sessions"],
    ["exam-batch", "student", "sessions"],
    ["exam-batch", "student", "access"],
    ["exam-batch", "student", "exams"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "student", "leaderboard"],
    ["exam-batch", "student", "progress"],
  ],
  exam_batch_subjects: [
    ["exam-batch", "admin", "subjects"],
    ["exam-batch", "admin", "enrollment", "subjects"],
    ["exam-batch", "admin", "academic"],
    ["exam-batch", "student", "subjects"],
    ["exam-batch", "student", "session-subjects"],
  ],
  exam_batch_chapters: [
    ["exam-batch", "admin", "chapters"],
    ["exam-batch", "admin", "academic"],
  ],
  exam_batch_levels: [
    ["exam-batch", "admin", "levels"],
    ["exam-batch", "admin", "academic"],
  ],
  exam_batch_mcqs: [
    ["exam-batch", "admin", "mcqs"],
    ["exam-batch", "admin", "mcqs-picker"],
  ],
  exam_batch_exams: [
    ["exam-batch", "admin", "exams"],
    ["exam-batch", "admin", "exams-for-leaderboard"],
    ["exam-batch", "student", "exams"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "student", "leaderboard"],
  ],
  exam_batch_exam_questions: [
    ["exam-batch", "admin", "exam-questions"],
  ],
  exam_batch_enrollments: [
    ["exam-batch", "admin", "enrollments"],
    ["exam-batch", "admin", "attendance"],
    ["exam-batch", "student", "my-enrollments"],
    ["exam-batch", "student", "access"],
    ["exam-batch", "student", "exams"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "student", "progress"],
  ],
  exam_batch_enrollment_subjects: [
    ["exam-batch", "admin", "enrollments"],
    ["exam-batch", "admin", "enrollment", "subjects"],
    ["exam-batch", "admin", "attendance"],
    ["exam-batch", "student", "my-enrollments"],
    ["exam-batch", "student", "access"],
    ["exam-batch", "student", "exams"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "student", "progress"],
  ],
  exam_batch_session_subjects: [
    ["exam-batch", "admin", "sessions"],
    ["exam-batch", "student", "session-subjects"],
  ],
  exam_batch_attempts: [
    ["exam-batch", "student", "attempt"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "student", "progress"],
    ["exam-batch", "admin", "analytics"],
    ["exam-batch", "admin", "leaderboard"],
  ],
  exam_batch_attempt_answers: [["exam-batch", "student", "attempt"]],
  exam_batch_attempt_results: [
    ["exam-batch", "student", "result"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "student", "progress"],
    ["exam-batch", "admin", "analytics"],
    ["exam-batch", "admin", "leaderboard"],
  ],
  exam_batch_leaderboards: [
    ["exam-batch", "student", "leaderboard"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "admin", "leaderboard"],
  ],
  exam_batch_leaderboard_entries: [
    ["exam-batch", "student", "leaderboard"],
    ["exam-batch", "student", "history"],
    ["exam-batch", "admin", "leaderboard"],
  ],
  exam_batch_progress_summaries: [["exam-batch", "student", "progress"]],
  exam_batch_analytics_snapshots: [["exam-batch", "admin", "analytics"]],
  exam_batch_attendance_state: [
    ["exam-batch", "admin", "attendance"],
    ["exam-batch", "student", "access"],
  ],
  exam_batch_attendance_processed: [
    ["exam-batch", "admin", "attendance"],
  ],
  exam_batch_attendance_events: [
    ["exam-batch", "admin", "attendance"],
  ],
  exam_batch_ban_history: [
    ["exam-batch", "admin", "attendance"],
  ],
  exam_batch_comment_rules: [
    ["exam-batch", "admin", "comment-rules"],
  ],
  exam_batch_download_history: [
    ["exam-batch", "admin", "download-history"],
  ],
  exam_batch_notifications: [
    ["exam-batch", "student", "notifications"],
    ["exam-batch", "admin", "notifications"],
  ],
};

const EXAM_BATCH_TABLES = Object.keys(TABLE_SCOPES);
const EXAM_BATCH_BROADCAST_EVENT = "exam-batch-db-change";

let mountCount = 0;
let sharedChannel: ReturnType<typeof supabase.channel> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Set<string>();

function flush(qc: QueryClient) {
  flushTimer = null;
  const seen = new Set<string>();
  for (const table of pending) {
    for (const key of TABLE_SCOPES[table] ?? []) {
      const sig = key.join("|");
      if (seen.has(sig)) continue;
      seen.add(sig);
      // Only refetch queries currently observed on-screen; cached-but-idle
      // pages stay warm and don't hit the network.
      void qc.invalidateQueries({ queryKey: key, refetchType: "active" });
    }
  }
  pending.clear();
}

function invalidateAll(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["exam-batch"], refetchType: "active" });
}

/**
 * Client-side fallback for Admin Panel writes that change student visibility.
 * Postgres realtime is RLS-filtered, so UPDATEs like publish → unpublish or
 * visible → hidden can be invisible to student sockets precisely when their
 * lists need to remove the row. Admin mutations broadcast a tiny invalidation
 * event after the write; students refetch through normal RLS-protected server
 * functions, so no row data is leaked.
 */
export function notifyExamBatchRealtime(table: keyof typeof TABLE_SCOPES | string) {
  const channel = sharedChannel;
  if (!channel) return;
  void channel.send({
    type: "broadcast",
    event: EXAM_BATCH_BROADCAST_EVENT,
    payload: { table, at: Date.now() },
  });
}

/**
 * Subscribes to postgres_changes on every exam-batch table and coalesces
 * bursts of events into scoped, per-table query invalidations. Safe to mount
 * from multiple places — the underlying channel is refcounted.
 */
export function useExamBatchRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    mountCount += 1;
    let cancelled = false;
    let authSub: { unsubscribe: () => void } | null = null;

    const scheduleInvalidate = (table: string) => {
      pending.add(table);
      if (flushTimer) return;
      flushTimer = setTimeout(() => flush(qc), 75);
    };

    // Realtime postgres_changes are subject to RLS. Without a JWT set on the
    // realtime socket, RLS-scoped rows (enrollments, notifications, etc.)
    // never reach the client. Push the current access token and keep it in
    // sync across sign-in / token-refresh events.
    const applyAuth = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token ?? null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.realtime as any).setAuth(token);
      } catch {
        /* noop */
      }
    };

    const ensureChannel = async () => {
      await applyAuth();
      if (cancelled || sharedChannel) return;
      const channel = supabase.channel("exam-batch-live", {
        config: { broadcast: { self: false } },
      });
      for (const table of EXAM_BATCH_TABLES) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (channel as any).on(
          "postgres_changes",
          { event: "*", schema: "public", table },
          () => scheduleInvalidate(table),
        );
      }
      channel.on("broadcast", { event: EXAM_BATCH_BROADCAST_EVENT }, (message) => {
        const table = (message.payload as { table?: string } | undefined)?.table;
        if (table && TABLE_SCOPES[table]) scheduleInvalidate(table);
        else invalidateAll(qc);
      });
      sharedChannel = channel;
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          invalidateAll(qc);
        }
      });
    };

    void ensureChannel();

    const handleOnline = () => invalidateAll(qc);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") invalidateAll(qc);
    };
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "SIGNED_OUT") {
        void applyAuth();
        invalidateAll(qc);
      }
    });
    authSub = sub.subscription;


    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      authSub?.unsubscribe();
      mountCount -= 1;
      if (mountCount <= 0) {
        mountCount = 0;
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        pending.clear();
        if (sharedChannel) {
          void supabase.removeChannel(sharedChannel);
          sharedChannel = null;
        }
      }
    };
  }, [qc]);
}
