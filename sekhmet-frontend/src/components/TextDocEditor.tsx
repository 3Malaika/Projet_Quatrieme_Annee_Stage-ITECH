import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";

export function TextDocEditor({
  title,
  description,
  endpoint,
  notice,
}: {
  title: string;
  description?: string;
  endpoint: string;
  notice?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: [endpoint],
    queryFn: () => api.get<{ content: string }>(endpoint),
  });

  useEffect(() => {
    if (data) setValue(data.content ?? "");
  }, [data]);

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const save = useMutation({
    mutationFn: () => api.put(endpoint, { content: value }),
    onSuccess: () => {
      toast.success("Enregistré avec succès.");
      queryClient.invalidateQueries({ queryKey: [endpoint] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader title={title} description={description} />
      {notice}
      {isLoading ? (
        <Skeleton className="h-[400px] w-full rounded-xl" />
      ) : (
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-h-[400px] resize-y rounded-xl bg-card font-mono text-sm leading-relaxed shadow-sm md:min-h-[520px]"
          placeholder="Saisissez le contenu..."
        />
      )}
      <div className="mt-4 flex justify-end">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || isLoading}
          className="w-full md:w-auto"
        >
          {save.isPending ? "Enregistrement..." : "Enregistrer"}
        </Button>
      </div>
    </div>
  );
}