/**
 * A supabase-js-shaped adapter over a raw `pg` client.
 *
 * Its whole reason for existing: the verification harnesses run the *production* functions
 * — `runAssemble`, `serveMcp`, `runTurn`, the six Studio tools — rather than a
 * reimplementation of them. Those functions take a `Db`, which is a `SupabaseClient`, and
 * PostgREST is not reachable from a container that has only Postgres. Swapping the
 * transport underneath the same call sites is what makes the harness a test of the code
 * that ships instead of a test of a copy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this is not
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It is not PostgREST. It implements the query-builder methods this codebase actually
 * calls, in the shapes it actually calls them, and nothing else. Two consequences worth
 * being explicit about, because both could otherwise turn a green harness into a false
 * one:
 *
 *   An unimplemented method THROWS rather than being ignored. A silent no-op filter would
 *   make a scoped query return every row and the assertion above it would still pass.
 *
 *   `.is(col, null)` and `.eq(col, null)` are different operators here exactly as they are
 *   in PostgREST, because a null compared with `=` silently matches nothing — which is the
 *   bug `currentRate` carries a comment about.
 */

/**
 * Column types, read from the database once per table.
 *
 * A JS array is ambiguous between `text[]` and a jsonb array, and nothing in the *value*
 * resolves it. The first version guessed from the contents — objects mean jsonb, an empty
 * array means jsonb — and the guess was wrong the first time it met `reshoot_shot_ids
 * uuid[]` holding `[]`, which Postgres rejected as a malformed array literal.
 *
 * The guess was never the right shape of answer. PostgREST does not guess because it knows
 * the column types, and so does this — there is a live connection right there. Asking costs
 * one query per table for the life of the process and removes the class of bug rather than
 * managing it.
 */
function typeCache(client) {
  const tables = new Map();

  return async function typesFor(table) {
    if (!tables.has(table)) {
      const { rows } = await client.query(
        `select column_name, data_type from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
        [table],
      );
      tables.set(table, new Map(rows.map((r) => [r.column_name, r.data_type])));
    }
    return tables.get(table);
  };
}

export function supabaseShim(client) {
  const typesFor = typeCache(client);
  return {
    from(table) {
      return builder(client, table, typesFor);
    },
    async rpc(name, params) {
      const keys = Object.keys(params ?? {});
      const args = keys.map((k, i) => `${k} => $${i + 1}`);
      try {
        const { rows } = await client.query(
          `select * from ${name}(${args.join(', ')})`,
          keys.map((k) => params[k]),
        );
        return { data: rows, error: null };
      } catch (err) {
        // Shaped like a PostgrestError, exactly as the query path is. A function that
        // signals by RAISE — `reorder_shots` rejecting a stale id list is the case that
        // found this — must reach the caller as `error`, because the caller branches on
        // `error.message` and an exception skips the branch written to handle it.
        return { data: null, error: { message: err.message, code: err.code ?? null } };
      }
    },
  };
}

function builder(client, table, typesFor) {
  const st = {
    table,
    mode: 'select',
    columns: '*',
    payload: null,
    conflict: null,
    ignoreDuplicates: false,
    where: [],
    orders: [],
    limit: null,
    returning: null,
  };

  const api = {
    select(c) {
      if (st.mode === 'select') st.columns = c ?? '*';
      else st.returning = c ?? '*';
      return api;
    },
    insert(p) {
      st.mode = 'insert';
      st.payload = Array.isArray(p) ? p : [p];
      return api;
    },
    upsert(p, opts) {
      st.mode = 'upsert';
      st.payload = Array.isArray(p) ? p : [p];
      st.conflict = opts?.onConflict ?? null;
      st.ignoreDuplicates = opts?.ignoreDuplicates === true;
      return api;
    },
    update(p) {
      st.mode = 'update';
      st.payload = p;
      return api;
    },
    delete() {
      st.mode = 'delete';
      return api;
    },
    eq(c, v) {
      st.where.push((params) => {
        params.push(v);
        return `${quote(c)} = $${params.length}`;
      });
      return api;
    },
    neq(c, v) {
      st.where.push((params) => {
        params.push(v);
        return `${quote(c)} <> $${params.length}`;
      });
      return api;
    },
    lte(c, v) {
      st.where.push((params) => {
        params.push(v);
        return `${quote(c)} <= $${params.length}`;
      });
      return api;
    },
    gte(c, v) {
      st.where.push((params) => {
        params.push(v);
        return `${quote(c)} >= $${params.length}`;
      });
      return api;
    },
    is(c, v) {
      // `is null`, not `= null`. The distinction is load-bearing; see the header.
      st.where.push(() => `${quote(c)} is ${v === null ? 'null' : v ? 'true' : 'false'}`);
      return api;
    },
    not(c, op, v) {
      if (op !== 'is') throw new Error(`supabaseShim: .not(${c}, '${op}') is not implemented.`);
      st.where.push(() => `${quote(c)} is not ${v === null ? 'null' : v ? 'true' : 'false'}`);
      return api;
    },
    in(c, vs) {
      st.where.push((params) => {
        if (vs.length === 0) return 'false';
        const ph = vs.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `${quote(c)} in (${ph.join(',')})`;
      });
      return api;
    },
    order(c, opts) {
      st.orders.push(`${quote(c)} ${opts?.ascending === false ? 'desc' : 'asc'}`);
      return api;
    },
    limit(n) {
      st.limit = n;
      return api;
    },
    async maybeSingle() {
      const { rows, error } = await exec();
      if (error) return { data: null, error };
      return { data: rows[0] ?? null, error: null };
    },
    async single() {
      const { rows, error } = await exec();
      if (error) return { data: null, error };
      return rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'no rows returned' } };
    },
    then(resolve, reject) {
      return exec().then(
        ({ rows, error }) => resolve(error ? { data: null, error } : { data: rows, error: null }),
        reject,
      );
    },
  };

  // Anything the codebase might reach for and this does not implement fails loudly. A
  // missing filter that silently did nothing would widen a scoped query and the assertion
  // above it would still pass.
  for (const name of ['contains', 'overlaps', 'like', 'ilike', 'match', 'or', 'filter', 'range', 'textSearch']) {
    api[name] = () => {
      throw new Error(`supabaseShim: .${name}() is not implemented — add it rather than working around it.`);
    };
  }

  return api;

  async function exec() {
    const types = await typesFor(st.table);
    const enc = (column, value) => encode(value, types.get(column));
    const params = [];
    const clauses = st.where.map((f) => f(params));
    const where = clauses.length ? ` where ${clauses.join(' and ')}` : '';
    const order = st.orders.length ? ` order by ${st.orders.join(', ')}` : '';
    const limit = st.limit === null ? '' : ` limit ${Number(st.limit)}`;

    try {
      if (st.mode === 'select') {
        const sql = `select ${st.columns} from ${quote(st.table)}${where}${order}${limit}`;
        return { rows: (await client.query(sql, params)).rows, error: null };
      }

      if (st.mode === 'delete') {
        const sql = `delete from ${quote(st.table)}${where} returning *`;
        return { rows: (await client.query(sql, params)).rows, error: null };
      }

      if (st.mode === 'update') {
        const cols = Object.keys(st.payload);
        const values = cols.map((c) => enc(c, st.payload[c]));
        const sets = cols.map((c, i) => `${quote(c)} = $${i + 1}`);
        // The WHERE placeholders continue after the SET ones.
        const tailParams = [];
        const tail = st.where.map((f) => f(tailParams));
        const shifted = tail.map((clause) =>
          clause.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + cols.length}`),
        );
        const sql =
          `update ${quote(st.table)} set ${sets.join(', ')}` +
          (shifted.length ? ` where ${shifted.join(' and ')}` : '') +
          ` returning ${st.returning ?? '*'}`;
        return { rows: (await client.query(sql, [...values, ...tailParams])).rows, error: null };
      }

      // insert / upsert
      const cols = [...new Set(st.payload.flatMap((r) => Object.keys(r)))];
      const values = [];
      const tuples = st.payload.map((row) => {
        const ph = cols.map((c) => {
          values.push(enc(c, row[c] === undefined ? null : row[c]));
          return `$${values.length}`;
        });
        return `(${ph.join(',')})`;
      });

      let conflict = '';
      if (st.mode === 'upsert') {
        const target = st.conflict ? `(${st.conflict.split(',').map((c) => quote(c.trim())).join(',')})` : '';
        conflict = st.ignoreDuplicates
          ? ` on conflict ${target} do nothing`
          : ` on conflict ${target} do update set ${cols
              .map((c) => `${quote(c)} = excluded.${quote(c)}`)
              .join(', ')}`;
      }

      const sql =
        `insert into ${quote(st.table)} (${cols.map(quote).join(',')}) values ${tuples.join(',')}` +
        conflict +
        ` returning ${st.returning ?? '*'}`;

      return { rows: (await client.query(sql, values)).rows, error: null };
    } catch (err) {
      // Shaped like a PostgrestError, because every caller in the codebase branches on
      // `error.message` and a thrown exception would skip the branch it is meant to take.
      return { rows: [], error: { message: err.message, code: err.code ?? null } };
    }
  }
}

/**
 * Bind a JS value for a column of the given SQL type.
 *
 * `dataType` comes from `information_schema.columns`: 'jsonb', 'json', 'ARRAY', or a scalar
 * type name. It is `undefined` only for a column the schema does not have, and that case is
 * left to Postgres to reject — a shim that silently dropped an unknown column would make a
 * typo in a payload look like a successful write.
 */
function encode(value, dataType) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  if (dataType === 'jsonb' || dataType === 'json') return JSON.stringify(value);
  if (dataType === 'ARRAY') return Array.isArray(value) ? value : [value];

  // No declared type to go on: fall back to shape. Reached only for a column the schema
  // does not declare, which Postgres is about to complain about anyway.
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function quote(identifier) {
  return /^[a-z_][a-z0-9_]*$/.test(identifier) ? identifier : `"${identifier}"`;
}
