import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, CATEGORIES, errorMessage, labelCategorie, type Produit } from "@/lib/api";
import { enqueue } from "@/hooks/useOfflineQueue";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

export const Route = createFileRoute("/catalogue")({
  head: () => ({
    meta: [
      { title: "Catalogue — Sekhmet Shop Admin" },
      {
        name: "description",
        content: "Gérez les produits bio et bien-être vendus par Sekhmet Shop à Yaoundé.",
      },
      { property: "og:title", content: "Catalogue — Sekhmet Shop Admin" },
      {
        property: "og:description",
        content: "Ajoutez, modifiez et suivez le stock des produits Sekhmet Shop.",
      },
    ],
  }),
  component: CataloguePage,
});

type FormState = {
  nom: string;
  unite: string;
  prix: string;
  stock: string;
  categorie: string;
};

const EMPTY: FormState = {
  nom: "",
  unite: "",
  prix: "",
  stock: "disponible",
  categorie: "poudres",
};

function CataloguePage() {
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Produit | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [toDelete, setToDelete] = useState<Produit | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/produits"],
    queryFn: () => api.get<Produit[]>("/api/produits"),
  });

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const grouped = useMemo(() => {
    const list = (data ?? []).filter((p) =>
      p.nom?.toLowerCase().includes(search.trim().toLowerCase()),
    );
    const map = new Map<string, Produit[]>();
    for (const p of list) {
      const key = p.categorie || "autres";
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, search]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/produits"] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  };

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        nom: form.nom,
        unite: form.unite,
        prix: Number(form.prix) || form.prix,
        stock: form.stock,
        categorie: form.categorie,
      };
      return editing
        ? api.put(`/api/produits/${editing.id}`, payload)
        : api.post("/api/produits", payload);
    },
    onSuccess: () => {
      toast.success(editing ? "Produit modifié." : "Produit ajouté.");
      setDialogOpen(false);
      setEditing(null);
      setForm(EMPTY);
      invalidate();
    },
    onError: (e) => {
      // Hors ligne : mise en file d'attente
      if (e instanceof ApiError && e.status === 0 && !isOnline) {
        const payload = {
          nom: form.nom,
          unite: form.unite,
          prix: Number(form.prix) || form.prix,
          stock: form.stock,
          categorie: form.categorie,
        };
        enqueue(
          editing
            ? { method: "put", path: `/api/produits/${editing.id}`, body: payload }
            : { method: "post", path: "/api/produits", body: payload }
        );
        toast.warning("Hors ligne — modification enregistrée localement et sera synchronisée à la reconnexion.");
        setDialogOpen(false);
        setEditing(null);
        setForm(EMPTY);
      } else {
        toast.error(errorMessage(e));
      }
    },
  });

  const remove = useMutation({
    mutationFn: (p: Produit) => api.del(`/api/produits/${p.id}`),
    onSuccess: () => {
      toast.success("Produit supprimé.");
      setToDelete(null);
      invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 0 && !isOnline && toDelete) {
        enqueue({ method: "del", path: `/api/produits/${toDelete.id}` });
        toast.warning("Hors ligne — suppression enregistrée localement et sera synchronisée à la reconnexion.");
        setToDelete(null);
      } else {
        toast.error(errorMessage(e));
      }
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setDialogOpen(true);
  };

  const openEdit = (p: Produit) => {
    setEditing(p);
    setForm({
      nom: p.nom ?? "",
      unite: p.unite ?? "",
      prix: String(p.prix ?? ""),
      stock: p.stock ?? "disponible",
      categorie: p.categorie ?? "autres",
    });
    setDialogOpen(true);
  };

  return (
    <div>
      <PageHeader title="Catalogue" description="Produits disponibles à la vente." />

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un produit"
            className="bg-card pl-9"
          />
        </div>
        <Button onClick={openCreate} className="w-full sm:w-auto">
          <Plus className="size-4" />
          Ajouter un produit
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Aucun produit à afficher.
        </p>
      ) : (
        <Accordion
          type="multiple"
          defaultValue={grouped.map(([c]) => c)}
          className="space-y-3"
        >
          {grouped.map(([categorie, produits]) => (
            <AccordionItem
              key={categorie}
              value={categorie}
              className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm"
            >
              <AccordionTrigger className="px-4 py-3 text-base font-semibold text-primary hover:no-underline">
                <span>
                  {labelCategorie(categorie)}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    ({produits.length})
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <ul className="divide-y divide-border/70">
                  {produits.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">{p.nom}</p>
                        <p className="text-sm text-muted-foreground">
                          {p.prix} FCFA {p.unite ? `· ${p.unite}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          className={
                            p.stock === "rupture"
                              ? "bg-accent text-accent-foreground"
                              : "bg-success text-success-foreground"
                          }
                        >
                          {p.stock === "rupture" ? "Rupture" : "Disponible"}
                        </Badge>
                        <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                          <Pencil className="size-4" />
                          Modifier
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setToDelete(p)}>
                          <Trash2 className="size-4 text-destructive" />
                          <span className="text-destructive">Supprimer</span>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-primary">
              {editing ? "Modifier le produit" : "Ajouter un produit"}
            </DialogTitle>
            <DialogDescription>Renseignez les informations du produit.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="nom">Nom</Label>
              <Input
                id="nom"
                required
                value={form.nom}
                onChange={(e) => setForm({ ...form, nom: e.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="unite">Unité</Label>
                <Input
                  id="unite"
                  value={form.unite}
                  onChange={(e) => setForm({ ...form, unite: e.target.value })}
                  placeholder="500 g, 1 L..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prix">Prix</Label>
                <Input
                  id="prix"
                  value={form.prix}
                  onChange={(e) => setForm({ ...form, prix: e.target.value })}
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Stock</Label>
                <Select
                  value={form.stock}
                  onValueChange={(v) => setForm({ ...form, stock: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disponible">Disponible</SelectItem>
                    <SelectItem value="rupture">Rupture</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Catégorie</Label>
                <Select
                  value={form.categorie}
                  onValueChange={(v) => setForm({ ...form, categorie: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {labelCategorie(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={save.isPending} className="w-full sm:w-auto">
                {save.isPending ? "Enregistrement..." : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer ce produit ?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.nom} sera définitivement retiré du catalogue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (toDelete) remove.mutate(toDelete);
              }}
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}