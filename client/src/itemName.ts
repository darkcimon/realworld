// 자산 표시 이름. 이름에 이미 브랜드가 들어 있으면("루이비통 가방") 브랜드를 앞에 또 붙이지 않는다
// ("루이비통 루이비통 가방" 방지).
export function itemDisplayName(item: { brand: string | null; name: string }): string {
  return item.brand && !item.name.startsWith(item.brand) ? `${item.brand} ${item.name}` : item.name;
}
