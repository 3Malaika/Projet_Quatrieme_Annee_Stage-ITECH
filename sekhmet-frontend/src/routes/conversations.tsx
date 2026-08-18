import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/conversations")({
  component: () => <Outlet />,
});

