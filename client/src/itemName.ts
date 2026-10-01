// 자산 표시 이름. 이름에 이미 브랜드가 들어 있으면("루이비통 가방") 브랜드를 앞에 또 붙이지 않는다
// ("루이비통 루이비통 가방" 방지).
export function itemDisplayName(item: { brand: string | null; name: string }): string {
  return item.brand && !item.name.startsWith(item.brand) ? `${item.brand} ${item.name}` : item.name;
}

// 같은 물건을 여러 개 전시하면 하나로 묶고 개수(×N)로 보여준다(처음 나온 순서 유지).
export function groupSameItems<T extends { category: string; brand: string | null; name: string }>(
  items: T[]
): { item: T; count: number }[] {
  const groups = new Map<string, { item: T; count: number }>();
  for (const it of items) {
    const key = `${it.category}|${itemDisplayName(it)}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { item: it, count: 1 });
  }
  return [...groups.values()];
}
