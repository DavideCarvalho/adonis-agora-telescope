import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable } from './data_table.js';

describe('DataTable client pagination', () => {
  it('renders one page of rows, not all of them', () => {
    const data = Array.from({ length: 23 }, (_, i) => ({ n: i }));
    const { container } = render(
      <DataTable
        id="paged"
        data={data}
        columns={[{ id: 'n', header: 'N', accessorFn: (r: { n: number }) => r.n }]}
        rowKey={(r) => String(r.n)}
        clientPageSize={10}
      />,
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(10);
  });
});
