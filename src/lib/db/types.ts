export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      assets: {
        Row: {
          bytes: number | null
          created_at: string
          duration_s: number | null
          generation_id: string | null
          height: number | null
          id: string
          kind: string
          meta: Json
          public_url: string | null
          r2_key: string
          width: number | null
        }
        Insert: {
          bytes?: number | null
          created_at?: string
          duration_s?: number | null
          generation_id?: string | null
          height?: number | null
          id?: string
          kind: string
          meta?: Json
          public_url?: string | null
          r2_key: string
          width?: number | null
        }
        Update: {
          bytes?: number | null
          created_at?: string
          duration_s?: number | null
          generation_id?: string | null
          height?: number | null
          id?: string
          kind?: string
          meta?: Json
          public_url?: string | null
          r2_key?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          created_at: string
          external_id: string | null
          handle: string | null
          id: string
          is_active: boolean
          name: string
          niche: string
          platform: string
          token_expires_at: string | null
          vault_secret_id: string | null
        }
        Insert: {
          created_at?: string
          external_id?: string | null
          handle?: string | null
          id?: string
          is_active?: boolean
          name: string
          niche: string
          platform: string
          token_expires_at?: string | null
          vault_secret_id?: string | null
        }
        Update: {
          created_at?: string
          external_id?: string | null
          handle?: string | null
          id?: string
          is_active?: boolean
          name?: string
          niche?: string
          platform?: string
          token_expires_at?: string | null
          vault_secret_id?: string | null
        }
        Relationships: []
      }
      characters: {
        Row: {
          created_at: string
          driver: string
          external_ref_id: string
          id: string
          name: string
          notes: string | null
          reference_urls: string[]
        }
        Insert: {
          created_at?: string
          driver: string
          external_ref_id: string
          id?: string
          name: string
          notes?: string | null
          reference_urls?: string[]
        }
        Update: {
          created_at?: string
          driver?: string
          external_ref_id?: string
          id?: string
          name?: string
          notes?: string | null
          reference_urls?: string[]
        }
        Relationships: []
      }
      concepts: {
        Row: {
          angle: string
          approved_at: string | null
          approved_by: string | null
          channel_id: string
          created_at: string
          id: string
          ip_risk: string
          killed_reason: string | null
          rubric_version: string
          score_total: number | null
          scores: Json
          source_signals: string[]
          status: string
          title: string
        }
        Insert: {
          angle: string
          approved_at?: string | null
          approved_by?: string | null
          channel_id: string
          created_at?: string
          id?: string
          ip_risk?: string
          killed_reason?: string | null
          rubric_version: string
          score_total?: number | null
          scores?: Json
          source_signals?: string[]
          status?: string
          title: string
        }
        Update: {
          angle?: string
          approved_at?: string | null
          approved_by?: string | null
          channel_id?: string
          created_at?: string
          id?: string
          ip_risk?: string
          killed_reason?: string | null
          rubric_version?: string
          score_total?: number | null
          scores?: Json
          source_signals?: string[]
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "concepts_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_ledger: {
        Row: {
          cost_inr: number | null
          cost_usd: number
          driver: string
          entry_kind: string
          generation_id: string | null
          id: string
          occurred_at: string
          quantity: number
          render_id: string | null
          unit: string
          usd_inr_rate: number | null
        }
        Insert: {
          cost_inr?: number | null
          cost_usd: number
          driver: string
          entry_kind?: string
          generation_id?: string | null
          id?: string
          occurred_at?: string
          quantity: number
          render_id?: string | null
          unit: string
          usd_inr_rate?: number | null
        }
        Update: {
          cost_inr?: number | null
          cost_usd?: number
          driver?: string
          entry_kind?: string
          generation_id?: string | null
          id?: string
          occurred_at?: string
          quantity?: number
          render_id?: string | null
          unit?: string
          usd_inr_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_render_id_fkey"
            columns: ["render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_render_id_fkey"
            columns: ["render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
        ]
      }
      driver_health: {
        Row: {
          consecutive_failures: number
          driver: string
          last_error_code: string | null
          last_failure_at: string | null
          last_success_at: string | null
          opened_at: string | null
          reopen_after: string | null
          state: string
          updated_at: string
        }
        Insert: {
          consecutive_failures?: number
          driver: string
          last_error_code?: string | null
          last_failure_at?: string | null
          last_success_at?: string | null
          opened_at?: string | null
          reopen_after?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          consecutive_failures?: number
          driver?: string
          last_error_code?: string | null
          last_failure_at?: string | null
          last_success_at?: string | null
          opened_at?: string | null
          reopen_after?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      generations: {
        Row: {
          attempt: number
          completed_at: string | null
          cost_inr: number | null
          credits_spent: number | null
          driver: string
          error_code: string | null
          error_detail: string | null
          external_job_id: string | null
          id: string
          idempotency_key: string
          kind: string
          model: string
          request_payload: Json
          shot_id: string | null
          status: string
          submitted_at: string
          unit_cost_snapshot: number | null
          wait_token: string | null
          webhook_received_at: string | null
        }
        Insert: {
          attempt?: number
          completed_at?: string | null
          cost_inr?: number | null
          credits_spent?: number | null
          driver: string
          error_code?: string | null
          error_detail?: string | null
          external_job_id?: string | null
          id?: string
          idempotency_key: string
          kind: string
          model: string
          request_payload: Json
          shot_id?: string | null
          status?: string
          submitted_at?: string
          unit_cost_snapshot?: number | null
          wait_token?: string | null
          webhook_received_at?: string | null
        }
        Update: {
          attempt?: number
          completed_at?: string | null
          cost_inr?: number | null
          credits_spent?: number | null
          driver?: string
          error_code?: string | null
          error_detail?: string | null
          external_job_id?: string | null
          id?: string
          idempotency_key?: string
          kind?: string
          model?: string
          request_payload?: Json
          shot_id?: string | null
          status?: string
          submitted_at?: string
          unit_cost_snapshot?: number | null
          wait_token?: string | null
          webhook_received_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "shots"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_snapshots: {
        Row: {
          age_bucket: string
          avg_view_pct: number | null
          captured_at: string
          comments: number | null
          id: string
          likes: number | null
          publication_id: string
          raw: Json
          retention_3s_pct: number | null
          saves: number | null
          shares: number | null
          views: number | null
        }
        Insert: {
          age_bucket: string
          avg_view_pct?: number | null
          captured_at?: string
          comments?: number | null
          id?: string
          likes?: number | null
          publication_id: string
          raw?: Json
          retention_3s_pct?: number | null
          saves?: number | null
          shares?: number | null
          views?: number | null
        }
        Update: {
          age_bucket?: string
          avg_view_pct?: number | null
          captured_at?: string
          comments?: number | null
          id?: string
          likes?: number | null
          publication_id?: string
          raw?: Json
          retention_3s_pct?: number | null
          saves?: number | null
          shares?: number | null
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "metrics_snapshots_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_snapshots_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["publication_id"]
          },
        ]
      }
      prompts: {
        Row: {
          created_at: string
          discovered_in: string | null
          driver: string
          id: string
          model: string
          name: string
          params: Json
          sample_output_url: string | null
          tags: string[] | null
          template: string
          version: number
          win_rate: number | null
        }
        Insert: {
          created_at?: string
          discovered_in?: string | null
          driver: string
          id?: string
          model: string
          name: string
          params?: Json
          sample_output_url?: string | null
          tags?: string[] | null
          template: string
          version?: number
          win_rate?: number | null
        }
        Update: {
          created_at?: string
          discovered_in?: string | null
          driver?: string
          id?: string
          model?: string
          name?: string
          params?: Json
          sample_output_url?: string | null
          tags?: string[] | null
          template?: string
          version?: number
          win_rate?: number | null
        }
        Relationships: []
      }
      publications: {
        Row: {
          altered_content_disclosed: boolean
          channel_id: string
          created_at: string
          description: string | null
          error_detail: string | null
          external_post_id: string | null
          external_url: string | null
          id: string
          published_at: string | null
          render_id: string
          review_id: string
          scheduled_for: string | null
          status: string
          tags: string[] | null
          thumbnail_asset_id: string | null
          title: string
        }
        Insert: {
          altered_content_disclosed?: boolean
          channel_id: string
          created_at?: string
          description?: string | null
          error_detail?: string | null
          external_post_id?: string | null
          external_url?: string | null
          id?: string
          published_at?: string | null
          render_id: string
          review_id: string
          scheduled_for?: string | null
          status?: string
          tags?: string[] | null
          thumbnail_asset_id?: string | null
          title: string
        }
        Update: {
          altered_content_disclosed?: boolean
          channel_id?: string
          created_at?: string
          description?: string | null
          error_detail?: string | null
          external_post_id?: string | null
          external_url?: string | null
          id?: string
          published_at?: string | null
          render_id?: string
          review_id?: string
          scheduled_for?: string | null
          status?: string
          tags?: string[] | null
          thumbnail_asset_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "publications_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publications_render_id_fkey"
            columns: ["render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publications_render_id_fkey"
            columns: ["render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
          {
            foreignKeyName: "publications_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publications_thumbnail_asset_id_fkey"
            columns: ["thumbnail_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_card: {
        Row: {
          currency: string
          driver: string
          effective_from: string
          id: string
          model: string
          unit: string
          unit_cost: number
        }
        Insert: {
          currency?: string
          driver: string
          effective_from?: string
          id?: string
          model: string
          unit: string
          unit_cost: number
        }
        Update: {
          currency?: string
          driver?: string
          effective_from?: string
          id?: string
          model?: string
          unit?: string
          unit_cost?: number
        }
        Relationships: []
      }
      renders: {
        Row: {
          asset_id: string | null
          created_at: string
          duration_s: number | null
          format: string
          height: number
          id: string
          render_ms: number | null
          script_id: string
          status: string
          variant_group_id: string
          variant_label: string
          width: number
        }
        Insert: {
          asset_id?: string | null
          created_at?: string
          duration_s?: number | null
          format: string
          height: number
          id?: string
          render_ms?: number | null
          script_id: string
          status?: string
          variant_group_id: string
          variant_label: string
          width: number
        }
        Update: {
          asset_id?: string | null
          created_at?: string
          duration_s?: number | null
          format?: string
          height?: number
          id?: string
          render_ms?: number | null
          script_id?: string
          status?: string
          variant_group_id?: string
          variant_label?: string
          width?: number
        }
        Relationships: [
          {
            foreignKeyName: "renders_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          created_at: string
          decision: string
          human_edit_count: number
          id: string
          notes: string | null
          render_id: string
          reshoot_shot_ids: string[] | null
          reviewer_id: string
          structure_novel: boolean
        }
        Insert: {
          created_at?: string
          decision: string
          human_edit_count?: number
          id?: string
          notes?: string | null
          render_id: string
          reshoot_shot_ids?: string[] | null
          reviewer_id: string
          structure_novel: boolean
        }
        Update: {
          created_at?: string
          decision?: string
          human_edit_count?: number
          id?: string
          notes?: string | null
          render_id?: string
          reshoot_shot_ids?: string[] | null
          reviewer_id?: string
          structure_novel?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "reviews_render_id_fkey"
            columns: ["render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_render_id_fkey"
            columns: ["render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
        ]
      }
      scripts: {
        Row: {
          beats: Json
          concept_id: string
          created_at: string
          cta: string | null
          draft_raw: string | null
          drafted_by: string
          hook: string
          human_edit_count: number
          human_edit_diff: string | null
          id: string
          structure_hash: string
          version: number
          vo_text: string
        }
        Insert: {
          beats: Json
          concept_id: string
          created_at?: string
          cta?: string | null
          draft_raw?: string | null
          drafted_by: string
          hook: string
          human_edit_count?: number
          human_edit_diff?: string | null
          id?: string
          structure_hash: string
          version?: number
          vo_text: string
        }
        Update: {
          beats?: Json
          concept_id?: string
          created_at?: string
          cta?: string | null
          draft_raw?: string | null
          drafted_by?: string
          hook?: string
          human_edit_count?: number
          human_edit_diff?: string | null
          id?: string
          structure_hash?: string
          version?: number
          vo_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "scripts_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
        ]
      }
      shots: {
        Row: {
          character_id: string | null
          compiled_params: Json | null
          created_at: string
          description: string
          duration_s: number
          id: string
          idx: number
          prompt_id: string | null
          script_id: string
          status: string
        }
        Insert: {
          character_id?: string | null
          compiled_params?: Json | null
          created_at?: string
          description: string
          duration_s: number
          id?: string
          idx: number
          prompt_id?: string | null
          script_id: string
          status?: string
        }
        Update: {
          character_id?: string | null
          compiled_params?: Json | null
          created_at?: string
          description?: string
          duration_s?: number
          id?: string
          idx?: number
          prompt_id?: string | null
          script_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "shots_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shots_prompt_fk"
            columns: ["prompt_id"]
            isOneToOne: false
            referencedRelation: "prompts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
        ]
      }
      trend_signals: {
        Row: {
          captured_at: string
          id: string
          raw: Json
          region: string | null
          source: string
          term: string
          velocity: number | null
          volume: number | null
        }
        Insert: {
          captured_at?: string
          id?: string
          raw?: Json
          region?: string | null
          source: string
          term: string
          velocity?: number | null
          volume?: number | null
        }
        Update: {
          captured_at?: string
          id?: string
          raw?: Json
          region?: string | null
          source?: string
          term?: string
          velocity?: number | null
          volume?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      v_cost_per_1k_views: {
        Row: {
          cost_inr: number | null
          cost_per_1k_views: number | null
          publication_id: string | null
          views: number | null
        }
        Relationships: []
      }
      v_render_cost: {
        Row: {
          cost_inr: number | null
          generations_used: number | null
          generations_wasted: number | null
          render_id: string | null
          script_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      dearmor: { Args: { "": string }; Returns: string }
      gen_random_uuid: { Args: never; Returns: string }
      gen_salt: { Args: { "": string }; Returns: string }
      pgp_armor_headers: {
        Args: { "": string }
        Returns: Record<string, unknown>[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
