import { getSessionHeaders } from "../session";

const BASE = "/api/shopping-list";

export interface ServerShoppingListItem {
  id: string;
  userId: string;
  itemName: string;
  quantity: number;
  unit: string | null;
  category: string | null;
  isChecked: boolean;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const shoppingListApi = {
  async getAll(): Promise<ServerShoppingListItem[]> {
    const res = await fetch(BASE, {
      headers: getSessionHeaders(),
      // ensure fresh on client
      cache: "no-store",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to fetch shopping list");
    }
    const data = await res.json();
    return data.items ?? [];
  },

  async addItem(itemName: string, quantity = 1, notes: string | null = null) {
    const res = await fetch(BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getSessionHeaders(),
      },
      body: JSON.stringify({ itemName, quantity, notes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to add item to list");
    }
    return res.json() as Promise<ServerShoppingListItem>;
  },

  async updateItem(id: string, updates: Partial<Pick<ServerShoppingListItem, "quantity" | "notes" | "isChecked" | "sortOrder">>) {
    const res = await fetch(`${BASE}/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...getSessionHeaders(),
      },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to update list item");
    }
    return res.json() as Promise<ServerShoppingListItem>;
  },

  async deleteItem(id: string) {
    const res = await fetch(`${BASE}/${id}`, {
      method: "DELETE",
      headers: getSessionHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Failed to delete list item");
    }
    return res.json().catch(() => ({ success: true }));
  },

  async clearAll(sessionOnly = true) {
    // For safety, fetch then delete (server also supports clear if we extend, but simple for now)
    const items = await this.getAll();
    await Promise.all(items.map((item) => this.deleteItem(item.id)));
  },
};
