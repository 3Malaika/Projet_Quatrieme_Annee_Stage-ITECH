import { createFileRoute } from "@tanstack/react-router";

import { PaniersListView } from "@/components/PaniersListView";

export const Route = createFileRoute("/paniers")({
  head: () => ({
    meta: [
      { title: "Paniers — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Consultez les paniers actuellement constitués par les clients sur WhatsApp.",
      },
    ],
  }),
  component: PaniersPage,
});

function PaniersPage() {
  return <PaniersListView />;
}
