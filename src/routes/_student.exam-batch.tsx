import { useEffect } from "react";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExamBatchLayout } from "@/components/exam-batch/layout";
import {
  useExamBatchStudentNav,
  useExamBatchAccess,
} from "@/components/exam-batch/access-gate";
import { StudentExamBatchBanPage } from "@/components/exam-batch/student-ban-page";
import { useExamBatchVisibility } from "@/hooks/use-exam-batch-visibility";
import { useHydrated } from "@/hooks/use-hydrated";
import { getExamBatchAccessState } from "@/lib/exam-batch/student-attendance.functions";
import { Loader2 } from "lucide-react";

// Paths that only make sense BEFORE approval.
const PRE_APPROVAL_PATHS = new Set<string>([
  "/exam-batch",
  "/exam-batch/",
  "/exam-batch/sessions",
  "/exam-batch/subjects",
  "/exam-batch/enrollment",
  "/exam-batch/pending",
]);

// Paths that require approval to reach.
const POST_APPROVAL_PREFIXES = [
  "/exam-batch/dashboard",
  "/exam-batch/available",
  "/exam-batch/upcoming",
  "/exam-batch/leaderboard",
  "/exam-batch/progress",
  "/exam-batch/history",
];

function normalize(p: string) {
  const n = p.replace(/\/+$/, "");
  return n === "" ? "/" : n;
}

function StudentExamBatchLayout() {
  const nav = useExamBatchStudentNav();
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { moduleVisible, isLoading: visibilityLoading } = useExamBatchVisibility();
  const {
    canAccessDashboard,
    enrollment,
    enrollmentStatus,
    isLoading: accessLoading,
  } = useExamBatchAccess();

  // Attendance / ban gate — realtime invalidations on
  // exam_batch_attendance_state (see use-exam-batch-realtime.ts) flip this
  // instantly for the affected student, no manual refresh required.
  const banStateQuery = useQuery({
    queryKey: ["exam-batch", "student", "access", "ban-state"],
    queryFn: () => getExamBatchAccessState(),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const banDecision = banStateQuery.data;

  // Compute the resolved target path from DB-driven access state.
  // Returns `null` while state is still loading (we then render a spinner
  // rather than showing whichever page is behind the URL, which caused the
  // Session-selection flash for approved students).
  const here = normalize(pathname);
  const ready = hydrated && !visibilityLoading && !accessLoading;

  let target: string | null = null;
  if (ready) {
    if (!moduleVisible) {
      target = "/dashboard";
    } else if (canAccessDashboard) {
      // DB says the student is APPROVED with an assigned Student ID.
      // They never see the Session selection screen — even on the
      // /exam-batch, /exam-batch/sessions, /exam-batch/subjects,
      // /exam-batch/enrollment or /exam-batch/pending URLs.
      target = PRE_APPROVAL_PATHS.has(here) ? "/exam-batch/dashboard" : here;
    } else if (enrollment && enrollmentStatus === "pending") {
      const inPostArea = POST_APPROVAL_PREFIXES.some((p) => here.startsWith(p));
      target =
        inPostArea || here === "/exam-batch/subjects" || here === "/exam-batch/enrollment"
          ? "/exam-batch/pending"
          : here;
    } else {
      // Not enrolled / rejected / removed assignment → Session selection.
      const inPostArea = POST_APPROVAL_PREFIXES.some((p) => here.startsWith(p));
      target =
        inPostArea || here === "/exam-batch/pending" ? "/exam-batch/sessions" : here;
    }
  }

  const needsRedirect = target !== null && target !== here;

  useEffect(() => {
    if (!needsRedirect || !target) return;
    navigate({ to: target as never, replace: true });
  }, [needsRedirect, target, navigate]);

  // Banned students see ONLY the ban screen inside the Exam Batch module.
  // The rest of the website (Dashboard, Quiz, Mock, MCQ Practice, etc.)
  // remains fully accessible.
  if (banDecision?.banned) {
    return (
      <ExamBatchLayout nav={[]}>
        <StudentExamBatchBanPage decision={banDecision} />
      </ExamBatchLayout>
    );
  }

  // Block child render while access state resolves OR while a redirect is
  // pending. This is the fix for the "Session selection appears every time"
  // bug: the Home / Sessions component must never render on top of an
  // approved student before the DB-backed decision is applied.
  if (!ready || needsRedirect) {
    return (
      <ExamBatchLayout nav={nav}>
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </ExamBatchLayout>
    );
  }

  return <ExamBatchLayout nav={nav} />;
}

export const Route = createFileRoute("/_student/exam-batch")({
  component: StudentExamBatchLayout,
  head: () => ({
    meta: [
      { title: "Exam Batch · CA Aspire BD" },
      { name: "description", content: "Your cohort-based exam preparation hub — sessions, subjects, exams and leaderboard." },
      { property: "og:title", content: "Exam Batch · CA Aspire BD" },
      { property: "og:description", content: "Cohort exam prep with live leaderboards and progress tracking." },
    ],
  }),
});

