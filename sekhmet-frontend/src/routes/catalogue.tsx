import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Pencil, Plus, Search, Trash2, Upload, Loader2, ImageOff, Minus } from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/AppLayout";
import { cn } from "@/lib/utils";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, CATEGORIES, errorMessage, labelCategorie, uploadProduitImage, type Category, type Produit } from "@/lib/api";
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
  description: string;
  imageUrl: string;
  quantite: string;
};

const EMPTY: FormState = {
  nom: "",
  unite: "",
  prix: "",
  stock: "disponible",
  categorie: "poudres",
  description: "",
  imageUrl: "",
  quantite: "0",
};

function CataloguePage() {
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("toutes");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Produit | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [toDelete, setToDelete] = useState<Produit | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; nom: string } | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["/api/produits"],
    queryFn: () => api.get<Produit[]>("/api/produits"),
  });
  const { data: categoryData } = useQuery({
    queryKey: ["/api/categories"],
    queryFn: () => api.get<Category[]>("/api/categories"),
  });
  const categories = categoryData?.map((category) => category.name) ?? [...CATEGORIES];

  useEffect(() => {
    if (isError) toast.error(errorMessage(error));
  }, [isError, error]);

  const grouped = useMemo(() => {
    const list = (data ?? []).filter((p) =>
      p.nom?.toLowerCase().includes(search.trim().toLowerCase()) &&
      (categoryFilter === "toutes" || (p.categorie || "autres") === categoryFilter),
    );
    const map = new Map<string, Produit[]>();
    for (const p of list) {
      const key = p.categorie || "autres";
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data, search, categoryFilter]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/produits"] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  };

  const buildPayload = () => ({
    nom: form.nom,
    unite: form.unite,
    prix: Number(form.prix) || form.prix,
    stock: form.stock,
    categorie: form.categorie,
    description: form.description,
    imageUrl: form.imageUrl,
    quantite: Number(form.quantite) || 0,
  });

  const save = useMutation({
    mutationFn: () => {
      const payload = buildPayload();
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
      if (e instanceof ApiError && e.status === 0 && !isOnline) {
        const payload = buildPayload();
        enqueue(
          editing
            ? { method: "put", path: `/api/produits/${editing.id}`, body: payload }
            : { method: "post", path: "/api/produits", body: payload }
        ).then(() => {
          toast.warning("Hors ligne — modification enregistrée localement et sera synchronisée à la reconnexion.");
          setDialogOpen(false);
          setEditing(null);
          setForm(EMPTY);
        });
      } else {
        toast.error(errorMessage(e));
      }
    },
  });

  // Ajustement rapide de la quantité directement depuis la liste (+/-),
  // sans ouvrir le formulaire complet. Optimiste : le compteur bouge tout de
  // suite, et se resynchronise avec le serveur juste après.
  const adjustQuantity = useMutation({
    mutationFn: ({ produit, next }: { produit: Produit; next: number }) =>
      api.put(`/api/produits/${produit.id}`, { quantite: next }),
    onMutate: async ({ produit, next }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/produits"] });
      const previous = queryClient.getQueryData<Produit[]>(["/api/produits"]);
      queryClient.setQueryData<Produit[]>(["/api/produits"], (old) =>
        (old ?? []).map((p) => (p.id === produit.id ? { ...p, quantite: next } : p))
      );
      return { previous };
    },
    onError: (e, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["/api/produits"], context.previous);
      toast.error(errorMessage(e));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/produits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
        enqueue({ method: "del", path: `/api/produits/${toDelete.id}` }).then(() => {
          toast.warning("Hors ligne — suppression enregistrée localement et sera synchronisée à la reconnexion.");
          setToDelete(null);
        });
      } else {
        toast.error(errorMessage(e));
      }
    },
  });

  const saveCategory = useMutation({
    mutationFn: () => editingCategory
      ? api.put(`/api/categories/${editingCategory.id}`, { name: categoryName })
      : api.post("/api/categories", { name: categoryName }),
    onSuccess: () => {
      toast.success(editingCategory ? "Catégorie modifiée." : "Catégorie ajoutée.");
      setCategoryDialogOpen(false);
      setEditingCategory(null);
      setCategoryName("");
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    },
    onError: async (e) => {
      if (e instanceof ApiError && e.status === 0 && !isOnline) {
        const normalizedName = categoryName.trim().toLowerCase().replace(/\s+/g, "_");
        await enqueue({
          method: editingCategory ? "put" : "post",
          path: editingCategory ? `/api/categories/${editingCategory.id}` : "/api/categories",
          body: { name: normalizedName },
        });
        const current = queryClient.getQueryData<Category[]>(["/api/categories"]) ?? [];
        const next = editingCategory
          ? current.map((category) => category.id === editingCategory.id ? { id: normalizedName, name: normalizedName } : category)
          : [...current, { id: normalizedName, name: normalizedName }];
        queryClient.setQueryData(["/api/categories"], next);
        toast.warning("Hors ligne — catégorie enregistrée localement et synchronisée à la reconnexion.");
        setCategoryDialogOpen(false);
        setEditingCategory(null);
        setCategoryName("");
      } else {
        toast.error(errorMessage(e));
      }
    },
  });

  const deleteCategory = useMutation({
    mutationFn: (category: Category) => api.del(`/api/categories/${category.id}`),
    onSuccess: () => {
      toast.success("Catégorie supprimée.");
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
      setCategoryFilter("toutes");
    },
    onError: async (e, category) => {
      if (e instanceof ApiError && e.status === 0 && !isOnline) {
        await enqueue({ method: "del", path: `/api/categories/${category.id}` });
        const current = queryClient.getQueryData<Category[]>(["/api/categories"]) ?? categories.map((name) => ({ id: name, name }));
        queryClient.setQueryData(["/api/categories"], current.filter((item) => item.id !== category.id));
        toast.warning("Hors ligne — suppression enregistrée localement et synchronisée à la reconnexion.");
      } else {
        toast.error(errorMessage(e));
      }
    },
  });

  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permet de resélectionner le même fichier ensuite
    if (!file) return;

    setUploading(true);
    try {
      const { url } = await uploadProduitImage(file);
      setForm((f) => ({ ...f, imageUrl: url }));
      toast.success("Photo envoyée.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

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
      description: p.description ?? "",
      imageUrl: p.imageUrl ?? "",
      quantite: String(p.quantite ?? 0),
    });
    setDialogOpen(true);
  };

  const openCategoryCreate = () => {
    setEditingCategory(null);
    setCategoryName("");
    setCategoryDialogOpen(true);
  };

  const selectCategoryToEdit = (value: string) => {
    if (value === "new") {
      setEditingCategory(null);
      setCategoryName("");
      return;
    }
    const category = (categoryData ?? []).find((item) => item.id === value) ?? { id: value, name: value };
    setEditingCategory(category);
    setCategoryName(category.name);
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
      <div className="category-scroll" aria-label="Filtrer par catégorie">
        <button className={cn("category-chip", categoryFilter === "toutes" && "active")} onClick={() => setCategoryFilter("toutes")}>Toutes</button>
        {categories.map((category) => (
          <button key={category} className={cn("category-chip", categoryFilter === category && "active")} onClick={() => setCategoryFilter(category)}>
            {labelCategorie(category)}
          </button>
        ))}
      </div>
      <button className="category-floating-button" aria-label="Créer ou modifier une catégorie" onClick={openCategoryCreate}><Plus /></button>

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
                      <div className="flex min-w-0 items-center gap-3">
                        {p.imageUrl ? (
                          <img
                            src={p.imageUrl}
                            alt={p.nom}
                            className="h-12 w-12 shrink-0 rounded-lg border border-border/70 object-cover cursor-zoom-in"
                            onClick={() => setPreviewImage({ url: p.imageUrl!, nom: p.nom })}
                            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                          />
                        ) : (
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-border/70 text-muted-foreground">
                            <ImageOff className="size-4" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="font-medium text-foreground">{p.nom}</p>
                          <p className="text-sm text-muted-foreground">
                            {p.prix} FCFA {p.unite ? `· ${p.unite}` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-1 rounded-md border border-border/70 px-1">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label={`Diminuer la quantité de ${p.nom}`}
                            disabled={adjustQuantity.isPending || (p.quantite ?? 0) <= 0}
                            onClick={() =>
                              adjustQuantity.mutate({ produit: p, next: Math.max(0, (p.quantite ?? 0) - 1) })
                            }
                          >
                            <Minus className="size-3.5" />
                          </Button>
                          <span className="w-7 text-center text-sm tabular-nums">{p.quantite ?? 0}</span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label={`Augmenter la quantité de ${p.nom}`}
                            disabled={adjustQuantity.isPending}
                            onClick={() => adjustQuantity.mutate({ produit: p, next: (p.quantite ?? 0) + 1 })}
                          >
                            <Plus className="size-3.5" />
                          </Button>
                        </div>
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
                <Label htmlFor="quantite">Quantité en stock</Label>
                <Input
                  id="quantite"
                  value={form.quantite}
                  onChange={(e) => setForm({ ...form, quantite: e.target.value })}
                  inputMode="numeric"
                  min={0}
                  type="number"
                />
              </div>
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
            <div className="space-y-2">
              <Label htmlFor="imageUrl">Photo</Label>
              <div className="flex gap-2">
                <Input
                  id="imageUrl"
                  value={form.imageUrl}
                  onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                  placeholder="https://... (ou envoyez un fichier)"
                  className="flex-1"
                />
                <Button type="button" variant="outline" disabled={uploading} className="shrink-0" asChild>
                  <label htmlFor="imageUpload" className="cursor-pointer">
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    <span className="ml-2 hidden sm:inline">Envoyer</span>
                  </label>
                </Button>
                <input
                  id="imageUpload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={handleFileSelect}
                />
              </div>
              {form.imageUrl && (
                <img
                  src={form.imageUrl}
                  alt="Aperçu"
                  className="mt-1 h-24 w-24 rounded-lg border object-cover"
                  onError={(e) => (e.currentTarget.style.display = "none")}
                />
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description détaillée</Label>
              <Textarea
                id="description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Envoyée avec la photo quand un client demande ce produit sur WhatsApp"
                rows={4}
              />
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

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-primary">Gérer les catégories</DialogTitle>
            <DialogDescription>Créez une catégorie ou sélectionnez-en une pour la modifier.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); saveCategory.mutate(); }}>
            <div className="space-y-2">
              <Label>Catégorie à modifier</Label>
              <Select value={editingCategory?.id ?? "new"} onValueChange={selectCategoryToEdit}>
                <SelectTrigger><SelectValue placeholder="Nouvelle catégorie" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">+ Nouvelle catégorie</SelectItem>
                  {categories.map((name) => <SelectItem key={name} value={name}>{labelCategorie(name)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Label htmlFor="category-name">Nom</Label>
            <Input id="category-name" required value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Ex. Compléments" />
            <DialogFooter>
              {editingCategory ? <Button type="button" variant="ghost" className="mr-auto text-destructive" onClick={() => {
                if (window.confirm(`Supprimer la catégorie « ${labelCategorie(editingCategory.name)} » ?`)) {
                  deleteCategory.mutate(editingCategory);
                  setCategoryDialogOpen(false);
                }
              }}><Trash2 className="size-4" />Supprimer</Button> : null}
              <Button type="submit" disabled={saveCategory.isPending}>{saveCategory.isPending ? "Enregistrement..." : "Enregistrer"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewImage} onOpenChange={(o) => !o && setPreviewImage(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-primary">{previewImage?.nom}</DialogTitle>
          </DialogHeader>
          {previewImage && (
            <img
              src={previewImage.url}
              alt={previewImage.nom}
              className="w-full rounded-lg border border-border/70 object-contain max-h-[70vh]"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}