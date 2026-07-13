import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ExamInterface, ExamInterfaceSkeleton } from "@/components/exam-batch/exam-interface";

const searchSchema = z.object({
  examId: z.string().uuid().optional(),
  attemptId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_student/exam-batch-take")({
  validateSearch: (search) => searchSchema.parse(search),
  component: ExamInterface,
  // Render the exam skeleton for ANY pending state — route-chunk download,
  // navigation transition, refresh — so the user never sees a blank pane
  // between clicking "Start Exam" and the interface mounting.
  pendingComponent: ExamInterfaceSkeleton,
  pendingMs: 0,
  pendingMinMs: 0,
  head: () => ({
    meta: [
      { title: "Exam in Progress · CA Aspire BD" },
      { name: "robots", content: "noindex" },
      {
        name: "description",
        content: "Take your Exam Batch exam with a distraction-free, secure interface.",
      },
    ],
  }),
});
