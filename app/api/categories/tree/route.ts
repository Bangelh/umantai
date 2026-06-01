import { NextResponse } from 'next/server';
import { wholeFoodsCategories } from '@/lib/categories';

// Type for the tree node as requested
export interface CategoryTreeNode {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  level: number;
  children: CategoryTreeNode[];
  isLeaf: boolean;
}

// Simple ID generator (stable based on path for now)
let idCounter = 1;
const idMap = new Map<string, number>();

function getId(path: string): number {
  if (!idMap.has(path)) {
    idMap.set(path, idCounter++);
  }
  return idMap.get(path)!;
}

function buildTreeNode(
  node: any,
  parentId: number | null,
  level: number,
  pathPrefix: string
): CategoryTreeNode {
  const currentPath = pathPrefix ? `${pathPrefix} > ${node.name}` : node.name;
  const id = getId(currentPath);

  const children: CategoryTreeNode[] = (node.subcategories || []).map((child: any) =>
    buildTreeNode(child, id, level + 1, currentPath)
  );

  return {
    id,
    name: node.name,
    slug: node.id || node.name.toLowerCase().replace(/\s+/g, '-'),
    parent_id: parentId,
    level,
    children,
    isLeaf: children.length === 0,
  };
}

export async function GET() {
  try {
    // Reset counter for consistent IDs per request (or keep global for stability)
    idCounter = 1;
    idMap.clear();

    // Root node
    const root: CategoryTreeNode = {
      id: getId("Todo Frutas y Verduras"),
      name: "Todo Frutas y Verduras",
      slug: "todo-frutas-y-verduras",
      parent_id: null,
      level: 0,
      children: [],
      isLeaf: false,
    };

    // Build Frutas and Verduras as Level 1
    if (wholeFoodsCategories.subcategories) {
      wholeFoodsCategories.subcategories.forEach((group) => {
        const groupNode = buildTreeNode(group, root.id, 1, "Todo Frutas y Verduras");
        root.children.push(groupNode);
      });
    }

    return NextResponse.json({
      success: true,
      data: root,
    });
  } catch (error) {
    console.error("Error building category tree:", error);
    return NextResponse.json(
      { success: false, error: "Failed to build category tree" },
      { status: 500 }
    );
  }
}
