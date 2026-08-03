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
          normalize_error: string | null
          normalized_at: string | null
          public_url: string | null
          source_meta: Json | null
          storage_key: string
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
          normalize_error?: string | null
          normalized_at?: string | null
          public_url?: string | null
          source_meta?: Json | null
          storage_key: string
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
          normalize_error?: string | null
          normalized_at?: string | null
          public_url?: string | null
          source_meta?: Json | null
          storage_key?: string
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
          {
            foreignKeyName: "assets_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "v_replayed_callbacks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "v_unconfirmed_terminal_generations"
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
          concept_id: string | null
          cost_inr: number | null
          cost_usd: number
          driver: string
          entry_kind: string
          generation_id: string | null
          id: string
          idempotency_key: string | null
          occurred_at: string
          quantity: number
          render_id: string | null
          script_id: string | null
          stage: string | null
          studio_session_id: string | null
          unit: string
          usd_inr_rate: number | null
        }
        Insert: {
          concept_id?: string | null
          cost_inr?: number | null
          cost_usd: number
          driver: string
          entry_kind?: string
          generation_id?: string | null
          id?: string
          idempotency_key?: string | null
          occurred_at?: string
          quantity: number
          render_id?: string | null
          script_id?: string | null
          stage?: string | null
          studio_session_id?: string | null
          unit: string
          usd_inr_rate?: number | null
        }
        Update: {
          concept_id?: string | null
          cost_inr?: number | null
          cost_usd?: number
          driver?: string
          entry_kind?: string
          generation_id?: string | null
          id?: string
          idempotency_key?: string | null
          occurred_at?: string
          quantity?: number
          render_id?: string | null
          script_id?: string | null
          stage?: string | null
          studio_session_id?: string | null
          unit?: string
          usd_inr_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "v_replayed_callbacks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "v_unconfirmed_terminal_generations"
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
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_studio_session_id_fkey"
            columns: ["studio_session_id"]
            isOneToOne: false
            referencedRelation: "studio_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_studio_session_id_fkey"
            columns: ["studio_session_id"]
            isOneToOne: false
            referencedRelation: "v_studio_session_spend"
            referencedColumns: ["session_id"]
          },
        ]
      }
      credit_purchases: {
        Row: {
          amount_usd: number | null
          created_at: string
          credits: number
          expires_at: string | null
          expiry_days: number
          id: string
          integration_id: string
          note: string | null
          purchased_at: string
        }
        Insert: {
          amount_usd?: number | null
          created_at?: string
          credits: number
          expires_at?: string | null
          expiry_days?: number
          id?: string
          integration_id: string
          note?: string | null
          purchased_at: string
        }
        Update: {
          amount_usd?: number | null
          created_at?: string
          credits?: number
          expires_at?: string | null
          expiry_days?: number
          id?: string
          integration_id?: string
          note?: string | null
          purchased_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_purchases_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_purchases_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
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
          confirmed_at: string | null
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
          origin: string
          parent_generation_id: string | null
          request_payload: Json
          shot_id: string | null
          status: string
          studio_session_id: string | null
          submitted_at: string
          unit_cost_snapshot: number | null
          wait_token: string | null
          webhook_deliveries: number
          webhook_last_received_at: string | null
          webhook_received_at: string | null
        }
        Insert: {
          attempt?: number
          completed_at?: string | null
          confirmed_at?: string | null
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
          origin?: string
          parent_generation_id?: string | null
          request_payload: Json
          shot_id?: string | null
          status?: string
          studio_session_id?: string | null
          submitted_at?: string
          unit_cost_snapshot?: number | null
          wait_token?: string | null
          webhook_deliveries?: number
          webhook_last_received_at?: string | null
          webhook_received_at?: string | null
        }
        Update: {
          attempt?: number
          completed_at?: string | null
          confirmed_at?: string | null
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
          origin?: string
          parent_generation_id?: string | null
          request_payload?: Json
          shot_id?: string | null
          status?: string
          studio_session_id?: string | null
          submitted_at?: string
          unit_cost_snapshot?: number | null
          wait_token?: string | null
          webhook_deliveries?: number
          webhook_last_received_at?: string | null
          webhook_received_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "generations_parent_generation_id_fkey"
            columns: ["parent_generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_parent_generation_id_fkey"
            columns: ["parent_generation_id"]
            isOneToOne: false
            referencedRelation: "v_replayed_callbacks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_parent_generation_id_fkey"
            columns: ["parent_generation_id"]
            isOneToOne: false
            referencedRelation: "v_unconfirmed_terminal_generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "shots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "v_shot_readiness"
            referencedColumns: ["shot_id"]
          },
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "v_unresolved_shots"
            referencedColumns: ["shot_id"]
          },
          {
            foreignKeyName: "generations_studio_session_id_fkey"
            columns: ["studio_session_id"]
            isOneToOne: false
            referencedRelation: "studio_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_studio_session_id_fkey"
            columns: ["studio_session_id"]
            isOneToOne: false
            referencedRelation: "v_studio_session_spend"
            referencedColumns: ["session_id"]
          },
        ]
      }
      integration_checks: {
        Row: {
          check_name: string
          checked_at: string
          detail: string | null
          id: string
          integration_id: string
          passed: boolean
        }
        Insert: {
          check_name: string
          checked_at?: string
          detail?: string | null
          id?: string
          integration_id: string
          passed: boolean
        }
        Update: {
          check_name?: string
          checked_at?: string
          detail?: string | null
          id?: string
          integration_id?: string
          passed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "integration_checks_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_checks_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
        ]
      }
      integration_events: {
        Row: {
          detail: string | null
          event: string
          id: string
          integration_id: string | null
          occurred_at: string
        }
        Insert: {
          detail?: string | null
          event: string
          id?: string
          integration_id?: string | null
          occurred_at?: string
        }
        Update: {
          detail?: string | null
          event?: string
          id?: string
          integration_id?: string | null
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_events_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_events_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
        ]
      }
      integration_secrets: {
        Row: {
          configured_at: string
          field_key: string
          id: string
          integration_id: string
          last_4: string
          rotated_at: string | null
          vault_secret_id: string
        }
        Insert: {
          configured_at?: string
          field_key: string
          id?: string
          integration_id: string
          last_4: string
          rotated_at?: string | null
          vault_secret_id: string
        }
        Update: {
          configured_at?: string
          field_key?: string
          id?: string
          integration_id?: string
          last_4?: string
          rotated_at?: string | null
          vault_secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "integration_secrets_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integration_secrets_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
        ]
      }
      integrations: {
        Row: {
          concurrency_limit: number | null
          concurrency_source: string
          config: Json
          created_at: string
          id: string
          is_enabled: boolean
          kind: string
          last_checked_at: string | null
          last_error: string | null
          last_verified_at: string | null
          profile_id: string | null
          slug: string
        }
        Insert: {
          concurrency_limit?: number | null
          concurrency_source?: string
          config?: Json
          created_at?: string
          id?: string
          is_enabled?: boolean
          kind: string
          last_checked_at?: string | null
          last_error?: string | null
          last_verified_at?: string | null
          profile_id?: string | null
          slug: string
        }
        Update: {
          concurrency_limit?: number | null
          concurrency_source?: string
          config?: Json
          created_at?: string
          id?: string
          is_enabled?: boolean
          kind?: string
          last_checked_at?: string | null
          last_error?: string | null
          last_verified_at?: string | null
          profile_id?: string | null
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "integrations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "v_deferred_steps"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      mcp_servers: {
        Row: {
          allowed_tools: string[] | null
          auth_mode: string
          created_at: string
          id: string
          is_enabled: boolean
          last_verified_at: string | null
          name: string
          url: string
          vault_secret_id: string | null
        }
        Insert: {
          allowed_tools?: string[] | null
          auth_mode: string
          created_at?: string
          id?: string
          is_enabled?: boolean
          last_verified_at?: string | null
          name: string
          url: string
          vault_secret_id?: string | null
        }
        Update: {
          allowed_tools?: string[] | null
          auth_mode?: string
          created_at?: string
          id?: string
          is_enabled?: boolean
          last_verified_at?: string | null
          name?: string
          url?: string
          vault_secret_id?: string | null
        }
        Relationships: []
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
      profiles: {
        Row: {
          created_at: string
          currency: string
          display_name: string | null
          email: string
          id: string
          onboarding_completed_at: string | null
          onboarding_completed_steps: number[]
          onboarding_deferrals: Json
          onboarding_deferred_steps: number[]
          onboarding_first_video_render_id: string | null
          onboarding_step: number
          timezone: string
          usd_inr_rate: number | null
        }
        Insert: {
          created_at?: string
          currency?: string
          display_name?: string | null
          email: string
          id: string
          onboarding_completed_at?: string | null
          onboarding_completed_steps?: number[]
          onboarding_deferrals?: Json
          onboarding_deferred_steps?: number[]
          onboarding_first_video_render_id?: string | null
          onboarding_step?: number
          timezone?: string
          usd_inr_rate?: number | null
        }
        Update: {
          created_at?: string
          currency?: string
          display_name?: string | null
          email?: string
          id?: string
          onboarding_completed_at?: string | null
          onboarding_completed_steps?: number[]
          onboarding_deferrals?: Json
          onboarding_deferred_steps?: number[]
          onboarding_first_video_render_id?: string | null
          onboarding_step?: number
          timezone?: string
          usd_inr_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_onboarding_first_video_render_id_fkey"
            columns: ["onboarding_first_video_render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_onboarding_first_video_render_id_fkey"
            columns: ["onboarding_first_video_render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
        ]
      }
      prompts: {
        Row: {
          accepts_character_ref: boolean
          created_at: string
          discovered_in: string | null
          driver: string
          id: string
          is_active: boolean
          last_compiled_at: string | null
          model: string
          name: string
          params: Json
          retired_at: string | null
          retired_reason: string | null
          sample_output_url: string | null
          tags: string[] | null
          template: string
          times_compiled: number
          times_shipped: number
          version: number
          win_rate: number | null
        }
        Insert: {
          accepts_character_ref?: boolean
          created_at?: string
          discovered_in?: string | null
          driver: string
          id?: string
          is_active?: boolean
          last_compiled_at?: string | null
          model: string
          name: string
          params?: Json
          retired_at?: string | null
          retired_reason?: string | null
          sample_output_url?: string | null
          tags?: string[] | null
          template: string
          times_compiled?: number
          times_shipped?: number
          version?: number
          win_rate?: number | null
        }
        Update: {
          accepts_character_ref?: boolean
          created_at?: string
          discovered_in?: string | null
          driver?: string
          id?: string
          is_active?: boolean
          last_compiled_at?: string | null
          model?: string
          name?: string
          params?: Json
          retired_at?: string | null
          retired_reason?: string | null
          sample_output_url?: string | null
          tags?: string[] | null
          template?: string
          times_compiled?: number
          times_shipped?: number
          version?: number
          win_rate?: number | null
        }
        Relationships: []
      }
      pronunciation_dictionaries: {
        Row: {
          created_at: string
          id: string
          language: string
          name: string
          rules_changed_at: string
          synced_at: string | null
          vendor_dictionary_id: string | null
          vendor_version_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          language?: string
          name: string
          rules_changed_at?: string
          synced_at?: string | null
          vendor_dictionary_id?: string | null
          vendor_version_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          language?: string
          name?: string
          rules_changed_at?: string
          synced_at?: string | null
          vendor_dictionary_id?: string | null
          vendor_version_id?: string | null
        }
        Relationships: []
      }
      pronunciations: {
        Row: {
          alphabet: string | null
          created_at: string
          dictionary_id: string | null
          grapheme: string
          id: string
          kind: string
          language: string
          notes: string | null
          replacement: string
        }
        Insert: {
          alphabet?: string | null
          created_at?: string
          dictionary_id?: string | null
          grapheme: string
          id?: string
          kind: string
          language?: string
          notes?: string | null
          replacement: string
        }
        Update: {
          alphabet?: string | null
          created_at?: string
          dictionary_id?: string | null
          grapheme?: string
          id?: string
          kind?: string
          language?: string
          notes?: string | null
          replacement?: string
        }
        Relationships: [
          {
            foreignKeyName: "pronunciations_dictionary_id_fkey"
            columns: ["dictionary_id"]
            isOneToOne: false
            referencedRelation: "pronunciation_dictionaries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pronunciations_dictionary_id_fkey"
            columns: ["dictionary_id"]
            isOneToOne: false
            referencedRelation: "v_pronunciation_locators"
            referencedColumns: ["id"]
          },
        ]
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
          endpoint: string | null
          id: string
          is_verified: boolean
          model: string
          source_note: string | null
          unit: string
          unit_cost: number
        }
        Insert: {
          currency?: string
          driver: string
          effective_from?: string
          endpoint?: string | null
          id?: string
          is_verified?: boolean
          model: string
          source_note?: string | null
          unit: string
          unit_cost: number
        }
        Update: {
          currency?: string
          driver?: string
          effective_from?: string
          endpoint?: string | null
          id?: string
          is_verified?: boolean
          model?: string
          source_note?: string | null
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
          kind: string
          origin: string
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
          kind?: string
          origin?: string
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
          kind?: string
          origin?: string
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
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
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
          compile_note: string | null
          compiled_at: string | null
          compiled_params: Json | null
          created_at: string
          description: string
          duration_s: number
          duration_source: string
          id: string
          idx: number
          prompt_id: string | null
          script_id: string
          shot_kind: string | null
          status: string
          vo_char_end: number | null
          vo_char_start: number | null
        }
        Insert: {
          character_id?: string | null
          compile_note?: string | null
          compiled_at?: string | null
          compiled_params?: Json | null
          created_at?: string
          description: string
          duration_s: number
          duration_source?: string
          id?: string
          idx: number
          prompt_id?: string | null
          script_id: string
          shot_kind?: string | null
          status?: string
          vo_char_end?: number | null
          vo_char_start?: number | null
        }
        Update: {
          character_id?: string | null
          compile_note?: string | null
          compiled_at?: string | null
          compiled_params?: Json | null
          created_at?: string
          description?: string
          duration_s?: number
          duration_source?: string
          id?: string
          idx?: number
          prompt_id?: string | null
          script_id?: string
          shot_kind?: string | null
          status?: string
          vo_char_end?: number | null
          vo_char_start?: number | null
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
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
        ]
      }
      studio_sessions: {
        Row: {
          channel_id: string | null
          cost_inr: number
          created_at: string
          id: string
          input_tokens: number
          model: string
          output_tokens: number
          script_id: string | null
          spend_cap_inr: number | null
          status: string
          stopped_at: string | null
          stopped_reason: string | null
          title: string | null
          transcript: Json
        }
        Insert: {
          channel_id?: string | null
          cost_inr?: number
          created_at?: string
          id?: string
          input_tokens?: number
          model: string
          output_tokens?: number
          script_id?: string | null
          spend_cap_inr?: number | null
          status?: string
          stopped_at?: string | null
          stopped_reason?: string | null
          title?: string | null
          transcript?: Json
        }
        Update: {
          channel_id?: string | null
          cost_inr?: number
          created_at?: string
          id?: string
          input_tokens?: number
          model?: string
          output_tokens?: number
          script_id?: string | null
          spend_cap_inr?: number | null
          status?: string
          stopped_at?: string | null
          stopped_reason?: string | null
          title?: string | null
          transcript?: Json
        }
        Relationships: [
          {
            foreignKeyName: "studio_sessions_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
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
      vo_takes: {
        Row: {
          asset_id: string | null
          characters_billed: number | null
          chunk_idx: number
          cost_inr: number | null
          created_at: string
          driver: string
          duration_s: number | null
          id: string
          language: string
          model: string
          offset_s: number
          request_id: string | null
          script_id: string
          seed: number | null
          text_in: string
          voice_id: string
          word_timings: Json
        }
        Insert: {
          asset_id?: string | null
          characters_billed?: number | null
          chunk_idx?: number
          cost_inr?: number | null
          created_at?: string
          driver: string
          duration_s?: number | null
          id?: string
          language?: string
          model: string
          offset_s?: number
          request_id?: string | null
          script_id: string
          seed?: number | null
          text_in: string
          voice_id: string
          word_timings?: Json
        }
        Update: {
          asset_id?: string | null
          characters_billed?: number | null
          chunk_idx?: number
          cost_inr?: number | null
          created_at?: string
          driver?: string
          duration_s?: number | null
          id?: string
          language?: string
          model?: string
          offset_s?: number
          request_id?: string | null
          script_id?: string
          seed?: number | null
          text_in?: string
          voice_id?: string
          word_timings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "vo_takes_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vo_takes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vo_takes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "vo_takes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
        ]
      }
    }
    Views: {
      v_cost_by_stage: {
        Row: {
          cost_inr: number | null
          cost_usd: number | null
          entries: number | null
          stage: string | null
        }
        Relationships: []
      }
      v_cost_per_1k_views: {
        Row: {
          cost_inr: number | null
          cost_per_1k_views: number | null
          publication_id: string | null
          views: number | null
        }
        Relationships: []
      }
      v_credit_position: {
        Row: {
          credits_expired: number | null
          credits_unexpired: number | null
          days_until_expiry: number | null
          integration_id: string | null
          last_purchase_at: string | null
          next_expiry: string | null
          slug: string | null
        }
        Relationships: []
      }
      v_deferred_steps: {
        Row: {
          deferred_at: string | null
          profile_id: string | null
          reason: string | null
          step: number | null
        }
        Relationships: []
      }
      v_pronunciation_locators: {
        Row: {
          id: string | null
          language: string | null
          name: string | null
          never_synced: boolean | null
          rules: number | null
          stale: boolean | null
          synced_at: string | null
          vendor_dictionary_id: string | null
          vendor_version_id: string | null
        }
        Insert: {
          id?: string | null
          language?: string | null
          name?: string | null
          never_synced?: never
          rules?: never
          stale?: never
          synced_at?: string | null
          vendor_dictionary_id?: string | null
          vendor_version_id?: string | null
        }
        Update: {
          id?: string | null
          language?: string | null
          name?: string | null
          never_synced?: never
          rules?: never
          stale?: never
          synced_at?: string | null
          vendor_dictionary_id?: string | null
          vendor_version_id?: string | null
        }
        Relationships: []
      }
      v_recipe_coverage: {
        Row: {
          active_recipes: number | null
          compiles: number | null
          ships: number | null
          shot_kind: string | null
          top_recipe_share: number | null
          total_recipes: number | null
        }
        Relationships: []
      }
      v_recipe_gaps: {
        Row: {
          active_recipes: number | null
          scripts_blocked: number | null
          seconds_waiting: number | null
          shot_kind: string | null
          shots_waiting: number | null
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
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
        ]
      }
      v_replayed_callbacks: {
        Row: {
          confirmed_at: string | null
          external_job_id: string | null
          id: string | null
          shot_id: string | null
          spread: string | null
          status: string | null
          webhook_deliveries: number | null
          webhook_last_received_at: string | null
          webhook_received_at: string | null
        }
        Insert: {
          confirmed_at?: string | null
          external_job_id?: string | null
          id?: string | null
          shot_id?: string | null
          spread?: never
          status?: string | null
          webhook_deliveries?: number | null
          webhook_last_received_at?: string | null
          webhook_received_at?: string | null
        }
        Update: {
          confirmed_at?: string | null
          external_job_id?: string | null
          id?: string | null
          shot_id?: string | null
          spread?: never
          status?: string | null
          webhook_deliveries?: number | null
          webhook_last_received_at?: string | null
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
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "v_shot_readiness"
            referencedColumns: ["shot_id"]
          },
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "v_unresolved_shots"
            referencedColumns: ["shot_id"]
          },
        ]
      }
      v_script_cost: {
        Row: {
          cost_inr: number | null
          draft_cost_inr: number | null
          generation_cost_inr: number | null
          generations_used: number | null
          generations_wasted: number | null
          script_id: string | null
        }
        Relationships: []
      }
      v_script_vo_status: {
        Row: {
          characters_billed: number | null
          fully_stitched: boolean | null
          script_id: string | null
          shots: number | null
          shots_timed: number | null
          takes: number | null
          total_duration_s: number | null
          vo_chars: number | null
          vo_text: string | null
        }
        Relationships: []
      }
      v_shot_readiness: {
        Row: {
          compile_note: string | null
          covers_speech: boolean | null
          duration_s: number | null
          duration_source: string | null
          generatable: boolean | null
          idx: number | null
          matching_recipes: number | null
          script_id: string | null
          shot_id: string | null
          shot_kind: string | null
          status: string | null
        }
        Insert: {
          compile_note?: string | null
          covers_speech?: never
          duration_s?: number | null
          duration_source?: string | null
          generatable?: never
          idx?: number | null
          matching_recipes?: never
          script_id?: string | null
          shot_id?: string | null
          shot_kind?: string | null
          status?: string | null
        }
        Update: {
          compile_note?: string | null
          covers_speech?: never
          duration_s?: number | null
          duration_source?: string | null
          generatable?: never
          idx?: number | null
          matching_recipes?: never
          script_id?: string | null
          shot_id?: string | null
          shot_kind?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
        ]
      }
      v_studio_session_spend: {
        Row: {
          cost_inr: number | null
          created_at: string | null
          input_tokens: number | null
          ledger_rows: number | null
          model: string | null
          output_tokens: number | null
          script_id: string | null
          session_id: string | null
          spend_cap_inr: number | null
          status: string | null
          stopped_reason: string | null
          title: string | null
          turns: number | null
        }
        Relationships: [
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
        ]
      }
      v_unconfirmed_terminal_generations: {
        Row: {
          completed_at: string | null
          external_job_id: string | null
          id: string | null
          shot_id: string | null
          status: string | null
          webhook_received_at: string | null
        }
        Insert: {
          completed_at?: string | null
          external_job_id?: string | null
          id?: string | null
          shot_id?: string | null
          status?: string | null
          webhook_received_at?: string | null
        }
        Update: {
          completed_at?: string | null
          external_job_id?: string | null
          id?: string | null
          shot_id?: string | null
          status?: string | null
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
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "v_shot_readiness"
            referencedColumns: ["shot_id"]
          },
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "v_unresolved_shots"
            referencedColumns: ["shot_id"]
          },
        ]
      }
      v_unresolved_shots: {
        Row: {
          channel_name: string | null
          compile_note: string | null
          concept_title: string | null
          description: string | null
          duration_s: number | null
          idx: number | null
          matching_recipes: number | null
          script_id: string | null
          shot_id: string | null
          shot_kind: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
        ]
      }
    }
    Functions: {
      assert_vault_available: { Args: never; Returns: undefined }
      confirm_generation_once: {
        Args: {
          p_error_code?: string
          p_error_detail?: string
          p_generation_id: string
          p_status: string
        }
        Returns: boolean
      }
      dearmor: { Args: { "": string }; Returns: string }
      defer_onboarding_step: {
        Args: { p_profile_id: string; p_reason: string; p_step: number }
        Returns: Json
      }
      gen_random_uuid: { Args: never; Returns: string }
      gen_salt: { Args: { "": string }; Returns: string }
      integration_secret_delete: {
        Args: { p_field_key: string; p_integration_id: string }
        Returns: boolean
      }
      integration_secret_put: {
        Args: {
          p_field_key: string
          p_integration_id: string
          p_secret: string
        }
        Returns: string
      }
      integration_secrets_read: {
        Args: { p_integration_id: string }
        Returns: {
          field_key: string
          secret: string
        }[]
      }
      pgp_armor_headers: {
        Args: { "": string }
        Returns: Record<string, unknown>[]
      }
      record_recipe_compile: {
        Args: { p_prompt_id: string }
        Returns: undefined
      }
      record_webhook_delivery: {
        Args: { p_job_id: string }
        Returns: {
          already_confirmed: boolean
          deliveries: number
          generation_id: string
        }[]
      }
      refresh_studio_session_spend: {
        Args: { p_session: string }
        Returns: undefined
      }
      undefer_onboarding_step: {
        Args: { p_profile_id: string; p_step: number }
        Returns: Json
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
