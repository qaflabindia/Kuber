<script lang="ts">
  import { NATURE_LABEL } from "$lib/format";
  let { accounts, value = $bindable(), name = "accountId", id, direction }: {
    accounts: { account_id: string; name: string; nature: string }[]; value: string; name?: string; id?: string; direction?: "in" | "out";
  } = $props();

  // Show the likely natures first: money out usually lands in expenses or liabilities, money in in income.
  const order = $derived(direction === "in" ? ["income", "liability", "asset", "equity", "expense"] : ["expense", "liability", "asset", "equity", "income"]);
  const groups = $derived(order.map((n) => ({ n, items: accounts.filter((a) => a.nature === n && a.account_id !== "SUSPENSE" && a.account_id !== "OPENING") })).filter((g) => g.items.length));
</script>

<select {name} {id} bind:value>
  {#if value === "SUSPENSE"}<option value="SUSPENSE" disabled>Choose where this belongs…</option>{/if}
  {#each groups as g}
    <optgroup label={NATURE_LABEL[g.n]}>
      {#each g.items as a}<option value={a.account_id}>{a.name}</option>{/each}
    </optgroup>
  {/each}
</select>
