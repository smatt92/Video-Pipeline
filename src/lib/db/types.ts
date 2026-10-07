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
      api_quota_usage: {
        Row: {
          detail: string | null
          endpoint: string
          id: string
          integration_id: string
          occurred_at: string
          publication_id: string | null
          succeeded: boolean | null
          units: number
        }
        Insert: {
          detail?: string | null
          endpoint: string
          id?: string
          integration_id: string
          occurred_at?: string
          publication_id?: string | null
          succeeded?: boolean | null
          units: number
        }
        Update: {
          detail?: string | null
          endpoint?: string
          id?: string
          integration_id?: string
          occurred_at?: string
          publication_id?: string | null
          succeeded?: boolean | null
          units?: number
        }
        Relationships: [
          {
            foreignKeyName: "api_quota_usage_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_quota_usage_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_api_quota"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "api_quota_usage_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "api_quota_usage_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_driver_limits"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "api_quota_usage_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_quota_usage_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "api_quota_usage_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "api_quota_usage_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_measurement_due"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "api_quota_usage_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_publish_queue"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "api_quota_usage_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_ready_bundles"
            referencedColumns: ["publication_id"]
          },
        ]
      }
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
            referencedRelation: "v_stuck_submits"
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
      authorship_log: {
        Row: {
          action: string
          actor_scope: string
          channel_id: string | null
          exact_text: string | null
          id: string
          occurred_at: string
          payload: Json
          profile_id: string | null
          subject_id: string
          subject_type: string
          token_id: string | null
        }
        Insert: {
          action: string
          actor_scope: string
          channel_id?: string | null
          exact_text?: string | null
          id?: string
          occurred_at?: string
          payload?: Json
          profile_id?: string | null
          subject_id: string
          subject_type: string
          token_id?: string | null
        }
        Update: {
          action?: string
          actor_scope?: string
          channel_id?: string | null
          exact_text?: string | null
          id?: string
          occurred_at?: string
          payload?: Json
          profile_id?: string | null
          subject_id?: string
          subject_type?: string
          token_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "authorship_log_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authorship_log_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "mcp_tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      briefs: {
        Row: {
          approved_at: string | null
          approved_by_token: string | null
          approved_edits: Json | null
          beat_sheet: Json
          catchphrase_used: string | null
          channel_id: string
          chosen_punchline: string | null
          created_at: string
          created_by: string
          created_by_token: string | null
          desk: string
          embedding_model: string | null
          ending_type: string
          episode: number | null
          estimate_basis: Json | null
          estimate_inr: number | null
          fact: Json
          flag_reasons: string[]
          flagged: boolean
          hook_archetype: string
          id: string
          lead_character: string
          music_bed: string
          pinned_comment: string
          policy: Json | null
          premise: string
          premise_type: string
          punchlines: Json
          reject_reason: string | null
          rejected_at: string | null
          script_embedding: string | null
          script_text: string
          season: number | null
          segments: Json | null
          series: string
          shot_list: Json
          slot_id: string | null
          source_comment_id: string | null
          status: string
          structure_variant: string
          supporting_characters: string[]
          tags: string[]
          title_embedding: string | null
          titles: Json
          variation: Json | null
        }
        Insert: {
          approved_at?: string | null
          approved_by_token?: string | null
          approved_edits?: Json | null
          beat_sheet: Json
          catchphrase_used?: string | null
          channel_id: string
          chosen_punchline?: string | null
          created_at?: string
          created_by: string
          created_by_token?: string | null
          desk: string
          embedding_model?: string | null
          ending_type: string
          episode?: number | null
          estimate_basis?: Json | null
          estimate_inr?: number | null
          fact: Json
          flag_reasons?: string[]
          flagged?: boolean
          hook_archetype: string
          id?: string
          lead_character: string
          music_bed: string
          pinned_comment: string
          policy?: Json | null
          premise: string
          premise_type: string
          punchlines: Json
          reject_reason?: string | null
          rejected_at?: string | null
          script_embedding?: string | null
          script_text: string
          season?: number | null
          segments?: Json | null
          series: string
          shot_list?: Json
          slot_id?: string | null
          source_comment_id?: string | null
          status?: string
          structure_variant: string
          supporting_characters?: string[]
          tags?: string[]
          title_embedding?: string | null
          titles: Json
          variation?: Json | null
        }
        Update: {
          approved_at?: string | null
          approved_by_token?: string | null
          approved_edits?: Json | null
          beat_sheet?: Json
          catchphrase_used?: string | null
          channel_id?: string
          chosen_punchline?: string | null
          created_at?: string
          created_by?: string
          created_by_token?: string | null
          desk?: string
          embedding_model?: string | null
          ending_type?: string
          episode?: number | null
          estimate_basis?: Json | null
          estimate_inr?: number | null
          fact?: Json
          flag_reasons?: string[]
          flagged?: boolean
          hook_archetype?: string
          id?: string
          lead_character?: string
          music_bed?: string
          pinned_comment?: string
          policy?: Json | null
          premise?: string
          premise_type?: string
          punchlines?: Json
          reject_reason?: string | null
          rejected_at?: string | null
          script_embedding?: string | null
          script_text?: string
          season?: number | null
          segments?: Json | null
          series?: string
          shot_list?: Json
          slot_id?: string | null
          source_comment_id?: string | null
          status?: string
          structure_variant?: string
          supporting_characters?: string[]
          tags?: string[]
          title_embedding?: string | null
          titles?: Json
          variation?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "briefs_approved_by_token_fkey"
            columns: ["approved_by_token"]
            isOneToOne: false
            referencedRelation: "mcp_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_created_by_token_fkey"
            columns: ["created_by_token"]
            isOneToOne: false
            referencedRelation: "mcp_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "briefs_source_comment_id_fkey"
            columns: ["source_comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_bibles: {
        Row: {
          channel_id: string
          policy: Json
          publishing: Json | null
          series: Json
          trend_sources: Json
          updated_at: string
          updated_by: string
          version: number
          world: Json
        }
        Insert: {
          channel_id: string
          policy: Json
          publishing?: Json | null
          series?: Json
          trend_sources?: Json
          updated_at?: string
          updated_by: string
          version?: number
          world: Json
        }
        Update: {
          channel_id?: string
          policy?: Json
          publishing?: Json | null
          series?: Json
          trend_sources?: Json
          updated_at?: string
          updated_by?: string
          version?: number
          world?: Json
        }
        Relationships: [
          {
            foreignKeyName: "channel_bibles_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: true
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_characters: {
        Row: {
          accent_hex: string
          active: boolean
          catchphrase: Json
          channel_id: string
          desk: string
          id: string
          name: string
          never_do: Json
          on_screen: boolean
          personality: string
          reference_frame: Json
          role: string
          season_introduced: number
          slug: string
          sort: number
          speech_rules: Json
          updated_at: string
          visual_lock: Json
          voice: Json
          voice_brief: string
        }
        Insert: {
          accent_hex: string
          active?: boolean
          catchphrase: Json
          channel_id: string
          desk?: string
          id?: string
          name: string
          never_do: Json
          on_screen?: boolean
          personality: string
          reference_frame?: Json
          role: string
          season_introduced?: number
          slug: string
          sort?: number
          speech_rules: Json
          updated_at?: string
          visual_lock: Json
          voice: Json
          voice_brief: string
        }
        Update: {
          accent_hex?: string
          active?: boolean
          catchphrase?: Json
          channel_id?: string
          desk?: string
          id?: string
          name?: string
          never_do?: Json
          on_screen?: boolean
          personality?: string
          reference_frame?: Json
          role?: string
          season_introduced?: number
          slug?: string
          sort?: number
          speech_rules?: Json
          updated_at?: string
          visual_lock?: Json
          voice?: Json
          voice_brief?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_characters_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_niche_vectors: {
        Row: {
          built_at: string
          channel_id: string
          embedding: string
          model: string
          source_count: number
          source_hash: string
          source_texts: Json
        }
        Insert: {
          built_at?: string
          channel_id: string
          embedding: string
          model: string
          source_count: number
          source_hash: string
          source_texts: Json
        }
        Update: {
          built_at?: string
          channel_id?: string
          embedding?: string
          model?: string
          source_count?: number
          source_hash?: string
          source_texts?: Json
        }
        Relationships: [
          {
            foreignKeyName: "channel_niche_vectors_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: true
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_policy: {
        Row: {
          caption_scale: number
          catchphrase_weekly_max: number
          channel_id: string
          character_beat_max_s: number
          daily_cap_inr: number
          daily_longform_cap_inr: number
          daily_publish_cap: number
          default_slot_time: string
          gate2_passed_at: string | null
          hook_archetype_weekly_max: number
          hook_s: number
          hook_scale: number
          instagram_publish_enabled: boolean
          kill_switch: boolean
          kill_switch_at: string | null
          kill_switch_reason: string | null
          line_gap_s: number
          loudness_target_lufs: number
          made_for_kids_default: boolean
          max_pictures_per_shot: number
          money_shot_max: number
          monthly_cap_after_gate2_inr: number
          monthly_cap_inr: number
          overlay_min_share: number
          per_short_cap_inr: number
          relevance_threshold: number
          rerolls_max: number
          seconds_per_picture: number
          similarity_max: number
          similarity_window: number
          slot_timezone: string
          stills_enabled: boolean
          synthetic_disclosure: string
          tail_s: number
          updated_at: string
          updated_by: string | null
          variation_min_axes: number
          variation_window: number
          voice_overflow: boolean
          youtube_api_audited: boolean
        }
        Insert: {
          caption_scale?: number
          catchphrase_weekly_max?: number
          channel_id: string
          character_beat_max_s?: number
          daily_cap_inr?: number
          daily_longform_cap_inr?: number
          daily_publish_cap?: number
          default_slot_time?: string
          gate2_passed_at?: string | null
          hook_archetype_weekly_max?: number
          hook_s?: number
          hook_scale?: number
          instagram_publish_enabled?: boolean
          kill_switch?: boolean
          kill_switch_at?: string | null
          kill_switch_reason?: string | null
          line_gap_s?: number
          loudness_target_lufs?: number
          made_for_kids_default?: boolean
          max_pictures_per_shot?: number
          money_shot_max?: number
          monthly_cap_after_gate2_inr?: number
          monthly_cap_inr?: number
          overlay_min_share?: number
          per_short_cap_inr?: number
          relevance_threshold?: number
          rerolls_max?: number
          seconds_per_picture?: number
          similarity_max?: number
          similarity_window?: number
          slot_timezone?: string
          stills_enabled?: boolean
          synthetic_disclosure?: string
          tail_s?: number
          updated_at?: string
          updated_by?: string | null
          variation_min_axes?: number
          variation_window?: number
          voice_overflow?: boolean
          youtube_api_audited?: boolean
        }
        Update: {
          caption_scale?: number
          catchphrase_weekly_max?: number
          channel_id?: string
          character_beat_max_s?: number
          daily_cap_inr?: number
          daily_longform_cap_inr?: number
          daily_publish_cap?: number
          default_slot_time?: string
          gate2_passed_at?: string | null
          hook_archetype_weekly_max?: number
          hook_s?: number
          hook_scale?: number
          instagram_publish_enabled?: boolean
          kill_switch?: boolean
          kill_switch_at?: string | null
          kill_switch_reason?: string | null
          line_gap_s?: number
          loudness_target_lufs?: number
          made_for_kids_default?: boolean
          max_pictures_per_shot?: number
          money_shot_max?: number
          monthly_cap_after_gate2_inr?: number
          monthly_cap_inr?: number
          overlay_min_share?: number
          per_short_cap_inr?: number
          relevance_threshold?: number
          rerolls_max?: number
          seconds_per_picture?: number
          similarity_max?: number
          similarity_window?: number
          slot_timezone?: string
          stills_enabled?: boolean
          synthetic_disclosure?: string
          tail_s?: number
          updated_at?: string
          updated_by?: string | null
          variation_min_axes?: number
          variation_window?: number
          voice_overflow?: boolean
          youtube_api_audited?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "channel_policy_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: true
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_publish_targets: {
        Row: {
          channel_id: string
          created_at: string
          enabled: boolean
          external_id: string | null
          handle: string | null
          platform: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          enabled?: boolean
          external_id?: string | null
          handle?: string | null
          platform: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          enabled?: boolean
          external_id?: string | null
          handle?: string | null
          platform?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_publish_targets_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_voice_overrides: {
        Row: {
          channel_id: string
          character_slug: string
          note: string | null
          set_at: string
          set_by: string | null
          voice_id: string
          voice_provider: string
        }
        Insert: {
          channel_id: string
          character_slug: string
          note?: string | null
          set_at?: string
          set_by?: string | null
          voice_id: string
          voice_provider: string
        }
        Update: {
          channel_id?: string
          character_slug?: string
          note?: string | null
          set_at?: string
          set_by?: string | null
          voice_id?: string
          voice_provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_voice_overrides_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          created_at: string
          external_id: string | null
          handle: string | null
          host_voice_id: string | null
          id: string
          is_active: boolean
          name: string
          niche: string
          platform: string
          slug: string | null
          token_expires_at: string | null
          token_last_refreshed_at: string | null
          token_refresh_error: string | null
          token_refresh_failures: number
          voice_language: string
        }
        Insert: {
          created_at?: string
          external_id?: string | null
          handle?: string | null
          host_voice_id?: string | null
          id?: string
          is_active?: boolean
          name: string
          niche: string
          platform: string
          slug?: string | null
          token_expires_at?: string | null
          token_last_refreshed_at?: string | null
          token_refresh_error?: string | null
          token_refresh_failures?: number
          voice_language?: string
        }
        Update: {
          created_at?: string
          external_id?: string | null
          handle?: string | null
          host_voice_id?: string | null
          id?: string
          is_active?: boolean
          name?: string
          niche?: string
          platform?: string
          slug?: string | null
          token_expires_at?: string | null
          token_last_refreshed_at?: string | null
          token_refresh_error?: string | null
          token_refresh_failures?: number
          voice_language?: string
        }
        Relationships: []
      }
      characters: {
        Row: {
          accent_hex: string | null
          bible: Json
          channel_id: string | null
          created_at: string
          driver: string | null
          external_ref_id: string | null
          id: string
          name: string
          notes: string | null
          on_screen: boolean
          reference_urls: string[]
          role: string | null
          season_introduced: number
          slug: string | null
          synced_at: string | null
          voice_id: string | null
        }
        Insert: {
          accent_hex?: string | null
          bible?: Json
          channel_id?: string | null
          created_at?: string
          driver?: string | null
          external_ref_id?: string | null
          id?: string
          name: string
          notes?: string | null
          on_screen?: boolean
          reference_urls?: string[]
          role?: string | null
          season_introduced?: number
          slug?: string | null
          synced_at?: string | null
          voice_id?: string | null
        }
        Update: {
          accent_hex?: string | null
          bible?: Json
          channel_id?: string | null
          created_at?: string
          driver?: string | null
          external_ref_id?: string | null
          id?: string
          name?: string
          notes?: string | null
          on_screen?: boolean
          reference_urls?: string[]
          role?: string | null
          season_introduced?: number
          slug?: string | null
          synced_at?: string | null
          voice_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "characters_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          author_handle: string | null
          body: string
          channel_id: string
          character_mentions: string[]
          complaint_score: number | null
          external_id: string
          fetched_at: string
          id: string
          is_public: boolean
          is_question: boolean
          like_count: number | null
          parent_external_id: string | null
          platform: string
          publication_id: string | null
          published_at: string | null
          reply_count: number | null
          used_in_brief_id: string | null
        }
        Insert: {
          author_handle?: string | null
          body: string
          channel_id: string
          character_mentions?: string[]
          complaint_score?: number | null
          external_id: string
          fetched_at?: string
          id?: string
          is_public?: boolean
          is_question?: boolean
          like_count?: number | null
          parent_external_id?: string | null
          platform: string
          publication_id?: string | null
          published_at?: string | null
          reply_count?: number | null
          used_in_brief_id?: string | null
        }
        Update: {
          author_handle?: string | null
          body?: string
          channel_id?: string
          character_mentions?: string[]
          complaint_score?: number | null
          external_id?: string
          fetched_at?: string
          id?: string
          is_public?: boolean
          is_question?: boolean
          like_count?: number | null
          parent_external_id?: string | null
          platform?: string
          publication_id?: string | null
          published_at?: string | null
          reply_count?: number | null
          used_in_brief_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comments_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "comments_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "comments_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_measurement_due"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "comments_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_publish_queue"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "comments_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_ready_bundles"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "comments_used_in_brief_fkey"
            columns: ["used_in_brief_id"]
            isOneToOne: false
            referencedRelation: "briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_used_in_brief_fkey"
            columns: ["used_in_brief_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "comments_used_in_brief_fkey"
            columns: ["used_in_brief_id"]
            isOneToOne: false
            referencedRelation: "v_variation_ledger"
            referencedColumns: ["brief_id"]
          },
        ]
      }
      competitor_videos: {
        Row: {
          computed_at: string | null
          external_video_id: string
          first_seen_at: string
          id: string
          last_seen_at: string
          outlier_score: number | null
          published_at: string
          scored_against_views: number | null
          title: string
          tracked_channel_id: string
          views: number | null
        }
        Insert: {
          computed_at?: string | null
          external_video_id: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          outlier_score?: number | null
          published_at: string
          scored_against_views?: number | null
          title: string
          tracked_channel_id: string
          views?: number | null
        }
        Update: {
          computed_at?: string | null
          external_video_id?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          outlier_score?: number | null
          published_at?: string
          scored_against_views?: number | null
          title?: string
          tracked_channel_id?: string
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "competitor_videos_tracked_channel_id_fkey"
            columns: ["tracked_channel_id"]
            isOneToOne: false
            referencedRelation: "tracked_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "competitor_videos_tracked_channel_id_fkey"
            columns: ["tracked_channel_id"]
            isOneToOne: false
            referencedRelation: "v_outlier_leaders"
            referencedColumns: ["tracked_channel_id"]
          },
          {
            foreignKeyName: "competitor_videos_tracked_channel_id_fkey"
            columns: ["tracked_channel_id"]
            isOneToOne: false
            referencedRelation: "v_tracked_channel_health"
            referencedColumns: ["tracked_channel_id"]
          },
        ]
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
          channel_id: string | null
          concept_id: string | null
          cost_inr: number | null
          cost_source: string
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
          channel_id?: string | null
          concept_id?: string | null
          cost_inr?: number | null
          cost_source?: string
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
          channel_id?: string | null
          concept_id?: string | null
          cost_inr?: number | null
          cost_source?: string
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
            foreignKeyName: "cost_ledger_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["concept_id"]
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
            referencedRelation: "v_stuck_submits"
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
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
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
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
            referencedRelation: "v_api_quota"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "credit_purchases_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "credit_purchases_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_driver_limits"
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
      dub_jobs: {
        Row: {
          audio_asset_id: string | null
          caption_render_id: string | null
          created_at: string
          credits_estimated: number | null
          episode_id: string
          error: string | null
          estimate_inr: number | null
          id: string
          language: string
          output_url_expires_at: string | null
          request_id: string | null
          requested_by: string
          srt_asset_id: string | null
          status: string
          token_id: string | null
          translated_lines: Json | null
          updated_at: string
        }
        Insert: {
          audio_asset_id?: string | null
          caption_render_id?: string | null
          created_at?: string
          credits_estimated?: number | null
          episode_id: string
          error?: string | null
          estimate_inr?: number | null
          id?: string
          language: string
          output_url_expires_at?: string | null
          request_id?: string | null
          requested_by: string
          srt_asset_id?: string | null
          status?: string
          token_id?: string | null
          translated_lines?: Json | null
          updated_at?: string
        }
        Update: {
          audio_asset_id?: string | null
          caption_render_id?: string | null
          created_at?: string
          credits_estimated?: number | null
          episode_id?: string
          error?: string | null
          estimate_inr?: number | null
          id?: string
          language?: string
          output_url_expires_at?: string | null
          request_id?: string | null
          requested_by?: string
          srt_asset_id?: string | null
          status?: string
          token_id?: string | null
          translated_lines?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dub_jobs_audio_asset_id_fkey"
            columns: ["audio_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dub_jobs_caption_render_id_fkey"
            columns: ["caption_render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dub_jobs_caption_render_id_fkey"
            columns: ["caption_render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
          {
            foreignKeyName: "dub_jobs_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dub_jobs_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_episode_spend"
            referencedColumns: ["episode_id"]
          },
          {
            foreignKeyName: "dub_jobs_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["episode_id"]
          },
          {
            foreignKeyName: "dub_jobs_srt_asset_id_fkey"
            columns: ["srt_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dub_jobs_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "mcp_tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      episodes: {
        Row: {
          brief_id: string
          channel_id: string
          concept_id: string | null
          created_at: string
          cut_wait_token: string | null
          estimate_inr: number | null
          final_render_id: string | null
          gen_wait_token: string | null
          id: string
          kind: string
          master_render_id: string | null
          publication_id: string | null
          qc: Json
          review_id: string | null
          run_id: string | null
          script_id: string | null
          slot_id: string | null
          status: string
          status_detail: string | null
          updated_at: string
          voice_detail: Json | null
        }
        Insert: {
          brief_id: string
          channel_id: string
          concept_id?: string | null
          created_at?: string
          cut_wait_token?: string | null
          estimate_inr?: number | null
          final_render_id?: string | null
          gen_wait_token?: string | null
          id?: string
          kind?: string
          master_render_id?: string | null
          publication_id?: string | null
          qc?: Json
          review_id?: string | null
          run_id?: string | null
          script_id?: string | null
          slot_id?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          voice_detail?: Json | null
        }
        Update: {
          brief_id?: string
          channel_id?: string
          concept_id?: string | null
          created_at?: string
          cut_wait_token?: string | null
          estimate_inr?: number | null
          final_render_id?: string | null
          gen_wait_token?: string | null
          id?: string
          kind?: string
          master_render_id?: string | null
          publication_id?: string | null
          qc?: Json
          review_id?: string | null
          run_id?: string | null
          script_id?: string | null
          slot_id?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          voice_detail?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "episodes_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: true
            referencedRelation: "briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: true
            referencedRelation: "v_slot_status"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "episodes_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: true
            referencedRelation: "v_variation_ledger"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "episodes_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["concept_id"]
          },
          {
            foreignKeyName: "episodes_final_render_id_fkey"
            columns: ["final_render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_final_render_id_fkey"
            columns: ["final_render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
          {
            foreignKeyName: "episodes_master_render_id_fkey"
            columns: ["master_render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_master_render_id_fkey"
            columns: ["master_render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
          {
            foreignKeyName: "episodes_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "publications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "episodes_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "episodes_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_measurement_due"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "episodes_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_publish_queue"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "episodes_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_ready_bundles"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "episodes_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "v_current_review"
            referencedColumns: ["review_id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "episodes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "episodes_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["id"]
          },
        ]
      }
      fact_sources: {
        Row: {
          brief_id: string
          checked_at: string | null
          claim: string
          created_at: string
          domain: string
          http_status: number | null
          id: string
          source_class: string
          title: string | null
          url: string
        }
        Insert: {
          brief_id: string
          checked_at?: string | null
          claim: string
          created_at?: string
          domain: string
          http_status?: number | null
          id?: string
          source_class: string
          title?: string | null
          url: string
        }
        Update: {
          brief_id?: string
          checked_at?: string | null
          claim?: string
          created_at?: string
          domain?: string
          http_status?: number | null
          id?: string
          source_class?: string
          title?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "fact_sources_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fact_sources_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "fact_sources_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "v_variation_ledger"
            referencedColumns: ["brief_id"]
          },
        ]
      }
      gen_jobs: {
        Row: {
          attempts: number
          created_at: string
          duration_s: number
          endpoint: string | null
          episode_id: string | null
          estimate_inr: number | null
          failover_of: string | null
          generation_id: string | null
          id: string
          idempotency_key: string
          last_error: string | null
          last_error_code: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          model: string
          next_attempt_at: string
          note: string | null
          params: Json
          poll_ref: Json
          prompt_id: string | null
          provider: string
          render_route: string
          request_id: string | null
          reroll_index: number
          reroll_of: string | null
          shot_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          duration_s: number
          endpoint?: string | null
          episode_id?: string | null
          estimate_inr?: number | null
          failover_of?: string | null
          generation_id?: string | null
          id?: string
          idempotency_key: string
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          model: string
          next_attempt_at?: string
          note?: string | null
          params: Json
          poll_ref?: Json
          prompt_id?: string | null
          provider: string
          render_route: string
          request_id?: string | null
          reroll_index?: number
          reroll_of?: string | null
          shot_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          duration_s?: number
          endpoint?: string | null
          episode_id?: string | null
          estimate_inr?: number | null
          failover_of?: string | null
          generation_id?: string | null
          id?: string
          idempotency_key?: string
          last_error?: string | null
          last_error_code?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          model?: string
          next_attempt_at?: string
          note?: string | null
          params?: Json
          poll_ref?: Json
          prompt_id?: string | null
          provider?: string
          render_route?: string
          request_id?: string | null
          reroll_index?: number
          reroll_of?: string | null
          shot_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gen_jobs_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_episode_spend"
            referencedColumns: ["episode_id"]
          },
          {
            foreignKeyName: "gen_jobs_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["episode_id"]
          },
          {
            foreignKeyName: "gen_jobs_failover_of_fkey"
            columns: ["failover_of"]
            isOneToOne: false
            referencedRelation: "gen_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "v_replayed_callbacks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "v_stuck_submits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "v_unconfirmed_terminal_generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_prompt_id_fkey"
            columns: ["prompt_id"]
            isOneToOne: false
            referencedRelation: "prompts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_prompt_id_fkey"
            columns: ["prompt_id"]
            isOneToOne: false
            referencedRelation: "v_recipe_performance"
            referencedColumns: ["prompt_id"]
          },
          {
            foreignKeyName: "gen_jobs_provider_fkey"
            columns: ["provider"]
            isOneToOne: false
            referencedRelation: "provider_limits"
            referencedColumns: ["provider"]
          },
          {
            foreignKeyName: "gen_jobs_provider_fkey"
            columns: ["provider"]
            isOneToOne: false
            referencedRelation: "v_gen_queue"
            referencedColumns: ["provider"]
          },
          {
            foreignKeyName: "gen_jobs_reroll_of_fkey"
            columns: ["reroll_of"]
            isOneToOne: false
            referencedRelation: "gen_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "shots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gen_jobs_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "v_unresolved_shots"
            referencedColumns: ["shot_id"]
          },
        ]
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
            referencedRelation: "v_stuck_submits"
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
            referencedRelation: "v_api_quota"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "integration_checks_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "integration_checks_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_driver_limits"
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
            referencedRelation: "v_api_quota"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "integration_events_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "integration_events_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_driver_limits"
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
            referencedRelation: "v_api_quota"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "integration_secrets_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_credit_position"
            referencedColumns: ["integration_id"]
          },
          {
            foreignKeyName: "integration_secrets_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "v_driver_limits"
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
          daily_quota_units: number | null
          id: string
          is_enabled: boolean
          kind: string
          last_checked_at: string | null
          last_error: string | null
          last_verified_at: string | null
          profile_id: string | null
          quota_source: string
          quota_window_tz: string
          referral_code: string | null
          referral_source: string | null
          referred_at: string | null
          slug: string
        }
        Insert: {
          concurrency_limit?: number | null
          concurrency_source?: string
          config?: Json
          created_at?: string
          daily_quota_units?: number | null
          id?: string
          is_enabled?: boolean
          kind: string
          last_checked_at?: string | null
          last_error?: string | null
          last_verified_at?: string | null
          profile_id?: string | null
          quota_source?: string
          quota_window_tz?: string
          referral_code?: string | null
          referral_source?: string | null
          referred_at?: string | null
          slug: string
        }
        Update: {
          concurrency_limit?: number | null
          concurrency_source?: string
          config?: Json
          created_at?: string
          daily_quota_units?: number | null
          id?: string
          is_enabled?: boolean
          kind?: string
          last_checked_at?: string | null
          last_error?: string | null
          last_verified_at?: string | null
          profile_id?: string | null
          quota_source?: string
          quota_window_tz?: string
          referral_code?: string | null
          referral_source?: string | null
          referred_at?: string | null
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
          {
            foreignKeyName: "integrations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "v_entry_state"
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
      mcp_tokens: {
        Row: {
          channel_id: string
          created_at: string
          expires_at: string | null
          id: string
          kind: string
          last_used_at: string | null
          name: string
          oauth_client_id: string | null
          oauth_redirect_uri: string | null
          profile_id: string | null
          revoked_at: string | null
          scope: string
          token_hash: string
          token_prefix: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: string
          last_used_at?: string | null
          name: string
          oauth_client_id?: string | null
          oauth_redirect_uri?: string | null
          profile_id?: string | null
          revoked_at?: string | null
          scope: string
          token_hash: string
          token_prefix: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: string
          last_used_at?: string | null
          name?: string
          oauth_client_id?: string | null
          oauth_redirect_uri?: string | null
          profile_id?: string | null
          revoked_at?: string | null
          scope?: string
          token_hash?: string
          token_prefix?: string
        }
        Relationships: [
          {
            foreignKeyName: "mcp_tokens_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcp_tokens_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mcp_tokens_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "v_deferred_steps"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "mcp_tokens_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "v_entry_state"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      metrics_snapshots: {
        Row: {
          age_bucket: string
          avg_view_pct: number | null
          captured_at: string
          comments: number | null
          engaged_views: number | null
          engaged_views_source: string | null
          entered_by: string | null
          id: string
          likes: number | null
          metric_source: string
          publication_id: string
          raw: Json
          retention_3s_pct: number | null
          saves: number | null
          shares: number | null
          status: string
          subs_gained: number | null
          unavailable_reason: string | null
          updated_at: string
          viewed_vs_swiped_pct: number | null
          views: number | null
        }
        Insert: {
          age_bucket: string
          avg_view_pct?: number | null
          captured_at?: string
          comments?: number | null
          engaged_views?: number | null
          engaged_views_source?: string | null
          entered_by?: string | null
          id?: string
          likes?: number | null
          metric_source?: string
          publication_id: string
          raw?: Json
          retention_3s_pct?: number | null
          saves?: number | null
          shares?: number | null
          status?: string
          subs_gained?: number | null
          unavailable_reason?: string | null
          updated_at?: string
          viewed_vs_swiped_pct?: number | null
          views?: number | null
        }
        Update: {
          age_bucket?: string
          avg_view_pct?: number | null
          captured_at?: string
          comments?: number | null
          engaged_views?: number | null
          engaged_views_source?: string | null
          entered_by?: string | null
          id?: string
          likes?: number | null
          metric_source?: string
          publication_id?: string
          raw?: Json
          retention_3s_pct?: number | null
          saves?: number | null
          shares?: number | null
          status?: string
          subs_gained?: number | null
          unavailable_reason?: string | null
          updated_at?: string
          viewed_vs_swiped_pct?: number | null
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
          {
            foreignKeyName: "metrics_snapshots_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "metrics_snapshots_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_measurement_due"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "metrics_snapshots_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_publish_queue"
            referencedColumns: ["publication_id"]
          },
          {
            foreignKeyName: "metrics_snapshots_publication_id_fkey"
            columns: ["publication_id"]
            isOneToOne: false
            referencedRelation: "v_ready_bundles"
            referencedColumns: ["publication_id"]
          },
        ]
      }
      music_bed_defaults: {
        Row: {
          bed_id: string
          channel_id: string
          series: string
          set_at: string
        }
        Insert: {
          bed_id: string
          channel_id: string
          series: string
          set_at?: string
        }
        Update: {
          bed_id?: string
          channel_id?: string
          series?: string
          set_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "music_bed_defaults_channel_id_bed_id_fkey"
            columns: ["channel_id", "bed_id"]
            isOneToOne: false
            referencedRelation: "music_beds"
            referencedColumns: ["channel_id", "bed_id"]
          },
        ]
      }
      music_beds: {
        Row: {
          bed_id: string
          bytes: number | null
          channel_id: string
          content_type: string
          storage_key: string
          uploaded_at: string
        }
        Insert: {
          bed_id: string
          bytes?: number | null
          channel_id: string
          content_type: string
          storage_key: string
          uploaded_at?: string
        }
        Update: {
          bed_id?: string
          bytes?: number | null
          channel_id?: string
          content_type?: string
          storage_key?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "music_beds_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          channel_id: string | null
          created_at: string
          dedupe_key: string | null
          delivered: boolean
          detail: string | null
          id: string
          kind: string
          text: string
        }
        Insert: {
          channel_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          delivered: boolean
          detail?: string | null
          id?: string
          kind: string
          text: string
        }
        Update: {
          channel_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          delivered?: boolean
          detail?: string | null
          id?: string
          kind?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_clients: {
        Row: {
          client_id: string
          client_name: string
          created_at: string
          last_seen_at: string
          metadata: Json
          redirect_uris: string[]
          registration: string
        }
        Insert: {
          client_id: string
          client_name: string
          created_at?: string
          last_seen_at?: string
          metadata?: Json
          redirect_uris: string[]
          registration: string
        }
        Update: {
          client_id?: string
          client_name?: string
          created_at?: string
          last_seen_at?: string
          metadata?: Json
          redirect_uris?: string[]
          registration?: string
        }
        Relationships: []
      }
      oauth_codes: {
        Row: {
          channel_id: string
          client_id: string
          code_challenge: string
          code_hash: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          grant_id: string | null
          profile_id: string
          redirect_uri: string
          resource: string
          scope: string
        }
        Insert: {
          channel_id: string
          client_id: string
          code_challenge: string
          code_hash: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          grant_id?: string | null
          profile_id: string
          redirect_uri: string
          resource: string
          scope: string
        }
        Update: {
          channel_id?: string
          client_id?: string
          code_challenge?: string
          code_hash?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          grant_id?: string | null
          profile_id?: string
          redirect_uri?: string
          resource?: string
          scope?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_codes_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_codes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "oauth_codes_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "mcp_tokens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_codes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_codes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "v_deferred_steps"
            referencedColumns: ["profile_id"]
          },
          {
            foreignKeyName: "oauth_codes_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "v_entry_state"
            referencedColumns: ["profile_id"]
          },
        ]
      }
      oauth_refresh_tokens: {
        Row: {
          created_at: string
          expires_at: string
          grant_id: string
          rotated_at: string | null
          token_hash: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          grant_id: string
          rotated_at?: string | null
          token_hash: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          grant_id?: string
          rotated_at?: string | null
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_refresh_tokens_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "mcp_tokens"
            referencedColumns: ["id"]
          },
        ]
      }
      pacing_template: {
        Row: {
          arc: string | null
          beats: number
          claim_to_example_ratio: number | null
          competitor_video_id: string
          cta_position: string | null
          extractor_version: string
          first_release_seconds: number | null
          hook_seconds: number
          id: string
          mean_shot_seconds: number | null
          measured_at: string
          shot_changes: number | null
          total_seconds: number
        }
        Insert: {
          arc?: string | null
          beats: number
          claim_to_example_ratio?: number | null
          competitor_video_id: string
          cta_position?: string | null
          extractor_version: string
          first_release_seconds?: number | null
          hook_seconds: number
          id?: string
          mean_shot_seconds?: number | null
          measured_at?: string
          shot_changes?: number | null
          total_seconds: number
        }
        Update: {
          arc?: string | null
          beats?: number
          claim_to_example_ratio?: number | null
          competitor_video_id?: string
          cta_position?: string | null
          extractor_version?: string
          first_release_seconds?: number | null
          hook_seconds?: number
          id?: string
          mean_shot_seconds?: number | null
          measured_at?: string
          shot_changes?: number | null
          total_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "pacing_template_competitor_video_id_fkey"
            columns: ["competitor_video_id"]
            isOneToOne: false
            referencedRelation: "competitor_videos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pacing_template_competitor_video_id_fkey"
            columns: ["competitor_video_id"]
            isOneToOne: false
            referencedRelation: "v_outlier_leaders"
            referencedColumns: ["competitor_video_id"]
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
          onboarding_seen_at: string | null
          onboarding_step: number
          timezone: string
          ui_scale: number
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
          onboarding_seen_at?: string | null
          onboarding_step?: number
          timezone?: string
          ui_scale?: number
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
          onboarding_seen_at?: string | null
          onboarding_step?: number
          timezone?: string
          ui_scale?: number
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
          model: string
          name: string
          params: Json
          retired_at: string | null
          retired_reason: string | null
          sample_output_url: string | null
          tags: string[] | null
          template: string
          version: number
        }
        Insert: {
          accepts_character_ref?: boolean
          created_at?: string
          discovered_in?: string | null
          driver: string
          id?: string
          is_active?: boolean
          model: string
          name: string
          params?: Json
          retired_at?: string | null
          retired_reason?: string | null
          sample_output_url?: string | null
          tags?: string[] | null
          template: string
          version?: number
        }
        Update: {
          accepts_character_ref?: boolean
          created_at?: string
          discovered_in?: string | null
          driver?: string
          id?: string
          is_active?: boolean
          model?: string
          name?: string
          params?: Json
          retired_at?: string | null
          retired_reason?: string | null
          sample_output_url?: string | null
          tags?: string[] | null
          template?: string
          version?: number
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
      provider_limits: {
        Row: {
          max_concurrency: number
          provider: string
          updated_at: string
        }
        Insert: {
          max_concurrency: number
          provider: string
          updated_at?: string
        }
        Update: {
          max_concurrency?: number
          provider?: string
          updated_at?: string
        }
        Relationships: []
      }
      publications: {
        Row: {
          altered_content_disclosed: boolean
          bundle: Json | null
          channel_id: string
          created_at: string
          description: string | null
          episode_id: string | null
          error_detail: string | null
          external_post_id: string | null
          external_url: string | null
          id: string
          idempotency_key: string | null
          made_for_kids: boolean
          marked_scheduled_at: string | null
          platform: string
          published_at: string | null
          render_id: string
          review_id: string
          scheduled_for: string | null
          slot_id: string | null
          status: string
          tags: string[] | null
          thumbnail_asset_id: string | null
          title: string
          upload_attempts: number
          upload_bytes_sent: number | null
          upload_session_url: string | null
          upload_started_at: string | null
          upload_total_bytes: number | null
        }
        Insert: {
          altered_content_disclosed?: boolean
          bundle?: Json | null
          channel_id: string
          created_at?: string
          description?: string | null
          episode_id?: string | null
          error_detail?: string | null
          external_post_id?: string | null
          external_url?: string | null
          id?: string
          idempotency_key?: string | null
          made_for_kids?: boolean
          marked_scheduled_at?: string | null
          platform?: string
          published_at?: string | null
          render_id: string
          review_id: string
          scheduled_for?: string | null
          slot_id?: string | null
          status?: string
          tags?: string[] | null
          thumbnail_asset_id?: string | null
          title: string
          upload_attempts?: number
          upload_bytes_sent?: number | null
          upload_session_url?: string | null
          upload_started_at?: string | null
          upload_total_bytes?: number | null
        }
        Update: {
          altered_content_disclosed?: boolean
          bundle?: Json | null
          channel_id?: string
          created_at?: string
          description?: string | null
          episode_id?: string | null
          error_detail?: string | null
          external_post_id?: string | null
          external_url?: string | null
          id?: string
          idempotency_key?: string | null
          made_for_kids?: boolean
          marked_scheduled_at?: string | null
          platform?: string
          published_at?: string | null
          render_id?: string
          review_id?: string
          scheduled_for?: string | null
          slot_id?: string | null
          status?: string
          tags?: string[] | null
          thumbnail_asset_id?: string | null
          title?: string
          upload_attempts?: number
          upload_bytes_sent?: number | null
          upload_session_url?: string | null
          upload_started_at?: string | null
          upload_total_bytes?: number | null
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
            foreignKeyName: "publications_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publications_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_episode_spend"
            referencedColumns: ["episode_id"]
          },
          {
            foreignKeyName: "publications_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["episode_id"]
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
            foreignKeyName: "publications_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "v_current_review"
            referencedColumns: ["review_id"]
          },
          {
            foreignKeyName: "publications_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publications_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
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
          language: string
          layer: string
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
          language?: string
          layer?: string
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
          language?: string
          layer?: string
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
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
          hook_pattern: string | null
          hook_pattern_version: string | null
          human_edit_count: number
          human_edit_diff: string | null
          id: string
          pilot_approved_at: string | null
          pilot_approved_by: string | null
          pilot_generation_id: string | null
          pilot_reject_reason: string | null
          pilot_rejected_at: string | null
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
          hook_pattern?: string | null
          hook_pattern_version?: string | null
          human_edit_count?: number
          human_edit_diff?: string | null
          id?: string
          pilot_approved_at?: string | null
          pilot_approved_by?: string | null
          pilot_generation_id?: string | null
          pilot_reject_reason?: string | null
          pilot_rejected_at?: string | null
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
          hook_pattern?: string | null
          hook_pattern_version?: string | null
          human_edit_count?: number
          human_edit_diff?: string | null
          id?: string
          pilot_approved_at?: string | null
          pilot_approved_by?: string | null
          pilot_generation_id?: string | null
          pilot_reject_reason?: string | null
          pilot_rejected_at?: string | null
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
          {
            foreignKeyName: "scripts_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["concept_id"]
          },
          {
            foreignKeyName: "scripts_pilot_generation_id_fkey"
            columns: ["pilot_generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_pilot_generation_id_fkey"
            columns: ["pilot_generation_id"]
            isOneToOne: false
            referencedRelation: "v_replayed_callbacks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_pilot_generation_id_fkey"
            columns: ["pilot_generation_id"]
            isOneToOne: false
            referencedRelation: "v_stuck_submits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_pilot_generation_id_fkey"
            columns: ["pilot_generation_id"]
            isOneToOne: false
            referencedRelation: "v_unconfirmed_terminal_generations"
            referencedColumns: ["id"]
          },
        ]
      }
      shots: {
        Row: {
          beat_id: string | null
          character_id: string | null
          character_slugs: string[]
          compile_note: string | null
          compiled_at: string | null
          compiled_params: Json | null
          created_at: string
          description: string
          duration_s: number
          duration_source: string
          effective_duration_s: number | null
          id: string
          idx: number
          overlay_spec: Json | null
          prompt_id: string | null
          realistic: boolean
          render_route: string | null
          script_id: string
          shot_kind: string | null
          source_render_id: string | null
          status: string
          trim_in_s: number | null
          trim_out_s: number | null
          vo_char_end: number | null
          vo_char_start: number | null
        }
        Insert: {
          beat_id?: string | null
          character_id?: string | null
          character_slugs?: string[]
          compile_note?: string | null
          compiled_at?: string | null
          compiled_params?: Json | null
          created_at?: string
          description: string
          duration_s: number
          duration_source?: string
          effective_duration_s?: number | null
          id?: string
          idx: number
          overlay_spec?: Json | null
          prompt_id?: string | null
          realistic?: boolean
          render_route?: string | null
          script_id: string
          shot_kind?: string | null
          source_render_id?: string | null
          status?: string
          trim_in_s?: number | null
          trim_out_s?: number | null
          vo_char_end?: number | null
          vo_char_start?: number | null
        }
        Update: {
          beat_id?: string | null
          character_id?: string | null
          character_slugs?: string[]
          compile_note?: string | null
          compiled_at?: string | null
          compiled_params?: Json | null
          created_at?: string
          description?: string
          duration_s?: number
          duration_source?: string
          effective_duration_s?: number | null
          id?: string
          idx?: number
          overlay_spec?: Json | null
          prompt_id?: string | null
          realistic?: boolean
          render_route?: string | null
          script_id?: string
          shot_kind?: string | null
          source_render_id?: string | null
          status?: string
          trim_in_s?: number | null
          trim_out_s?: number | null
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
            foreignKeyName: "shots_prompt_fk"
            columns: ["prompt_id"]
            isOneToOne: false
            referencedRelation: "v_recipe_performance"
            referencedColumns: ["prompt_id"]
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_source_render_id_fkey"
            columns: ["source_render_id"]
            isOneToOne: false
            referencedRelation: "renders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shots_source_render_id_fkey"
            columns: ["source_render_id"]
            isOneToOne: false
            referencedRelation: "v_render_cost"
            referencedColumns: ["render_id"]
          },
        ]
      }
      slots: {
        Row: {
          channel_id: string
          created_at: string
          episode: string | null
          hook: string | null
          id: string
          kind: string
          lead: string | null
          notes: string | null
          seasonal_tag: string | null
          series: string
          series_name: string
          slot_date: string | null
          topic: string
          topic_status: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          episode?: string | null
          hook?: string | null
          id: string
          kind: string
          lead?: string | null
          notes?: string | null
          seasonal_tag?: string | null
          series: string
          series_name: string
          slot_date?: string | null
          topic: string
          topic_status: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          episode?: string | null
          hook?: string | null
          id?: string
          kind?: string
          lead?: string | null
          notes?: string | null
          seasonal_tag?: string | null
          series?: string
          series_name?: string
          slot_date?: string | null
          topic?: string
          topic_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "slots_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_memos: {
        Row: {
          body: string
          channel_id: string
          created_at: string
          created_by: string
          gates: Json
          id: string
          token_id: string | null
          week_of: string
        }
        Insert: {
          body: string
          channel_id: string
          created_at?: string
          created_by: string
          gates?: Json
          id?: string
          token_id?: string | null
          week_of: string
        }
        Update: {
          body?: string
          channel_id?: string
          created_at?: string
          created_by?: string
          gates?: Json
          id?: string
          token_id?: string | null
          week_of?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_memos_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strategy_memos_token_id_fkey"
            columns: ["token_id"]
            isOneToOne: false
            referencedRelation: "mcp_tokens"
            referencedColumns: ["id"]
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
            referencedColumns: ["script_id"]
          },
        ]
      }
      tracked_channels: {
        Row: {
          added_at: string
          baseline_computed_at: string | null
          baseline_median_views: number | null
          baseline_video_count: number
          external_channel_id: string
          id: string
          is_active: boolean
          last_error: string | null
          last_polled_at: string | null
          niche: string
          poll_failures: number
          title: string
          uploads_playlist_id: string | null
        }
        Insert: {
          added_at?: string
          baseline_computed_at?: string | null
          baseline_median_views?: number | null
          baseline_video_count?: number
          external_channel_id: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_polled_at?: string | null
          niche: string
          poll_failures?: number
          title: string
          uploads_playlist_id?: string | null
        }
        Update: {
          added_at?: string
          baseline_computed_at?: string | null
          baseline_median_views?: number | null
          baseline_video_count?: number
          external_channel_id?: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_polled_at?: string | null
          niche?: string
          poll_failures?: number
          title?: string
          uploads_playlist_id?: string | null
        }
        Relationships: []
      }
      trend_runs: {
        Row: {
          channel_id: string | null
          finished_at: string
          id: string
          inserted: number
          relevance: Json | null
          sources: Json
          started_at: string
          trigger: string
          updated: number
        }
        Insert: {
          channel_id?: string | null
          finished_at?: string
          id?: string
          inserted: number
          relevance?: Json | null
          sources: Json
          started_at: string
          trigger: string
          updated: number
        }
        Update: {
          channel_id?: string | null
          finished_at?: string
          id?: string
          inserted?: number
          relevance?: Json | null
          sources?: Json
          started_at?: string
          trigger?: string
          updated?: number
        }
        Relationships: [
          {
            foreignKeyName: "trend_runs_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      trend_signals: {
        Row: {
          captured_at: string
          channel_id: string | null
          id: string
          raw: Json
          region: string | null
          relevance: number | null
          relevance_scored_at: string | null
          source: string
          term: string
          velocity: number | null
          volume: number | null
        }
        Insert: {
          captured_at?: string
          channel_id?: string | null
          id?: string
          raw?: Json
          region?: string | null
          relevance?: number | null
          relevance_scored_at?: string | null
          source: string
          term: string
          velocity?: number | null
          volume?: number | null
        }
        Update: {
          captured_at?: string
          channel_id?: string | null
          id?: string
          raw?: Json
          region?: string | null
          relevance?: number | null
          relevance_scored_at?: string | null
          source?: string
          term?: string
          velocity?: number | null
          volume?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trend_signals_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      trend_term_embeddings: {
        Row: {
          created_at: string
          embedding: string
          model: string
          term: string
        }
        Insert: {
          created_at?: string
          embedding: string
          model: string
          term: string
        }
        Update: {
          created_at?: string
          embedding?: string
          model?: string
          term?: string
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "vo_takes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "vo_takes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "vo_takes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "vo_takes_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
            referencedColumns: ["script_id"]
          },
        ]
      }
    }
    Views: {
      v_api_quota: {
        Row: {
          calls_made: number | null
          daily_quota_units: number | null
          integration_id: string | null
          quota_source: string | null
          resets_in: string | null
          slug: string | null
          units_remaining: number | null
          units_used: number | null
          units_wasted: number | null
          window_resets_at: string | null
          window_started_at: string | null
        }
        Relationships: []
      }
      v_channel_spend: {
        Row: {
          channel_id: string | null
          daily_cap_inr: number | null
          daily_longform_cap_inr: number | null
          kill_switch: boolean | null
          month_inr: number | null
          monthly_cap_effective_inr: number | null
          per_short_cap_inr: number | null
          today_inr: number | null
        }
        Relationships: [
          {
            foreignKeyName: "channel_policy_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: true
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_character_mentions: {
        Row: {
          channel_id: string | null
          day: string | null
          mentions: number | null
          slug: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comments_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_concept_cost: {
        Row: {
          batch_inr: number | null
          channel_id: string | null
          concepts_landed: number | null
          inr_per_concept: number | null
          period: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_cost_attributed: {
        Row: {
          channel_id: string | null
          component: string | null
          concept_id: string | null
          cost_inr: number | null
          cost_source: string | null
          cost_usd: number | null
          driver: string | null
          entry_kind: string | null
          generation_id: string | null
          id: string | null
          incurred: boolean | null
          occurred_at: string | null
          render_id: string | null
          script_id: string | null
          studio_session_id: string | null
          subject_script_id: string | null
          unit: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["concept_id"]
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
            referencedRelation: "v_stuck_submits"
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
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
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
      v_cost_by_stage: {
        Row: {
          entries: number | null
          first_at: string | null
          inr_per_script: number | null
          last_at: string | null
          open_estimate_inr: number | null
          scripts: number | null
          settled_inr: number | null
          stage: string | null
          unpriced_rows: number | null
        }
        Relationships: []
      }
      v_cost_per_1k_views: {
        Row: {
          age_bucket: string | null
          channel_id: string | null
          cost_basis: string | null
          cost_per_1k_inr: number | null
          denominator_state: string | null
          estimated_inr: number | null
          incurred_inr: number | null
          measured_inr: number | null
          metric_source: string | null
          publication_id: string | null
          published_at: string | null
          retention_3s_pct: number | null
          script_id: string | null
          snapshot_status: string | null
          state: string | null
          title: string | null
          unpriced_incurred_rows: number | null
          views: number | null
        }
        Relationships: [
          {
            foreignKeyName: "publications_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_cost_unattributed: {
        Row: {
          component: string | null
          entry_kind: string | null
          first_at: string | null
          inr: number | null
          last_at: string | null
          rows_n: number | null
          unpriced: number | null
        }
        Relationships: []
      }
      v_credit_position: {
        Row: {
          amount_usd: number | null
          credits_expired: number | null
          credits_expiring_30d: number | null
          credits_recorded: number | null
          credits_spent_total: number | null
          credits_unexpired: number | null
          days_until_expiry: number | null
          integration_id: string | null
          kind: string | null
          last_purchase_at: string | null
          next_expiry: string | null
          purchases: number | null
          slug: string | null
        }
        Relationships: []
      }
      v_current_review: {
        Row: {
          created_at: string | null
          decision: string | null
          human_edit_count: number | null
          notes: string | null
          render_id: string | null
          reshoot_shot_ids: string[] | null
          review_id: string | null
          structure_novel: boolean | null
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
      v_deferred_steps: {
        Row: {
          deferred_at: string | null
          profile_id: string | null
          reason: string | null
          step: number | null
        }
        Relationships: []
      }
      v_driver_limits: {
        Row: {
          concurrency_limit: number | null
          concurrency_source: string | null
          hits_concurrency: number | null
          hits_credits: number | null
          hits_rate: number | null
          in_flight: number | null
          integration_id: string | null
          is_enabled: boolean | null
          is_verified: boolean | null
          kind: string | null
          last_hit_at: string | null
          slug: string | null
          submits_total: number | null
        }
        Insert: {
          concurrency_limit?: number | null
          concurrency_source?: string | null
          hits_concurrency?: never
          hits_credits?: never
          hits_rate?: never
          in_flight?: never
          integration_id?: string | null
          is_enabled?: boolean | null
          is_verified?: never
          kind?: string | null
          last_hit_at?: never
          slug?: string | null
          submits_total?: never
        }
        Update: {
          concurrency_limit?: number | null
          concurrency_source?: string | null
          hits_concurrency?: never
          hits_credits?: never
          hits_rate?: never
          in_flight?: never
          integration_id?: string | null
          is_enabled?: boolean | null
          is_verified?: never
          kind?: string | null
          last_hit_at?: never
          slug?: string | null
          submits_total?: never
        }
        Relationships: []
      }
      v_entry_state: {
        Row: {
          completed_steps: number | null
          deferred_steps: number | null
          email: string | null
          onboarding_seen: boolean | null
          profile_id: string | null
          setup_complete: boolean | null
        }
        Insert: {
          completed_steps?: never
          deferred_steps?: never
          email?: string | null
          onboarding_seen?: never
          profile_id?: string | null
          setup_complete?: never
        }
        Update: {
          completed_steps?: never
          deferred_steps?: never
          email?: string | null
          onboarding_seen?: never
          profile_id?: string | null
          setup_complete?: never
        }
        Relationships: []
      }
      v_episode_spend: {
        Row: {
          brief_id: string | null
          channel_id: string | null
          episode_id: string | null
          spent_inr: number | null
          unpriced_rows: number | null
        }
        Relationships: [
          {
            foreignKeyName: "episodes_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: true
            referencedRelation: "briefs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: true
            referencedRelation: "v_slot_status"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "episodes_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: true
            referencedRelation: "v_variation_ledger"
            referencedColumns: ["brief_id"]
          },
          {
            foreignKeyName: "episodes_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_gen_queue: {
        Row: {
          failed_24h: number | null
          in_flight: number | null
          max_concurrency: number | null
          provider: string | null
          queued: number | null
          succeeded_24h: number | null
          throttled: number | null
        }
        Relationships: []
      }
      v_hook_performance: {
        Row: {
          best_retention_3s_pct: number | null
          hook_pattern: string | null
          median_retention_3s_pct: number | null
          median_views: number | null
          videos_measured: number | null
          videos_with_retention: number | null
          worst_retention_3s_pct: number | null
        }
        Relationships: []
      }
      v_hook_unclassified: {
        Row: {
          channel_id: string | null
          hook: string | null
          hook_pattern_version: string | null
          publication_id: string | null
          published_at: string | null
          script_id: string | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "publications_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_ledger_effective: {
        Row: {
          channel_id: string | null
          component: string | null
          concept_id: string | null
          cost_inr: number | null
          cost_source: string | null
          cost_usd: number | null
          driver: string | null
          eff_channel_id: string | null
          eff_script_id: string | null
          entry_kind: string | null
          generation_id: string | null
          id: string | null
          incurred: boolean | null
          occurred_at: string | null
          render_id: string | null
          script_id: string | null
          studio_session_id: string | null
          subject_script_id: string | null
          unit: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["concept_id"]
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
            referencedRelation: "v_stuck_submits"
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
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "scripts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_script_cost"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "cost_ledger_script_id_fkey"
            columns: ["subject_script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
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
      v_measurement_coverage: {
        Row: {
          captured: number | null
          captured_share: number | null
          channel_id: string | null
          due: number | null
          outstanding: number | null
          publications_due: number | null
          publications_measured: number | null
          unavailable: number | null
        }
        Relationships: [
          {
            foreignKeyName: "publications_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_measurement_due: {
        Row: {
          age_bucket: string | null
          captured_at: string | null
          channel_id: string | null
          coverage_state: string | null
          due_at: string | null
          publication_id: string | null
          published_at: string | null
          render_id: string | null
          retention_3s_pct: number | null
          snapshot_id: string | null
          snapshot_status: string | null
          title: string | null
          views: number | null
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
        ]
      }
      v_outlier_leaders: {
        Row: {
          age: string | null
          channel_title: string | null
          competitor_video_id: string | null
          computed_at: string | null
          external_video_id: string | null
          niche: string | null
          outlier_score: number | null
          published_at: string | null
          scored_against_views: number | null
          title: string | null
          tracked_channel_id: string | null
          views: number | null
        }
        Relationships: []
      }
      v_partner_rollup: {
        Row: {
          cost_inr: number | null
          driver: string | null
          generations: number | null
          period: string | null
          renders_completed: number | null
          unit: string | null
          units_consumed: number | null
        }
        Relationships: []
      }
      v_pipeline_blockers: {
        Row: {
          awaiting_pilot_approval: boolean | null
          blocker: string | null
          blocker_is_workspace_wide: boolean | null
          channel_id: string | null
          concept_id: string | null
          created_at: string | null
          script_id: string | null
          title: string | null
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
      v_publish_queue: {
        Row: {
          altered_content_disclosed: boolean | null
          blocker: string | null
          channel_id: string | null
          error_detail: string | null
          publication_id: string | null
          render_id: string | null
          render_status: string | null
          review_decision: string | null
          scheduled_for: string | null
          status: string | null
          title: string | null
          upload_attempts: number | null
          upload_bytes_sent: number | null
          upload_total_bytes: number | null
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
        ]
      }
      v_ready_bundles: {
        Row: {
          altered_content_disclosed: boolean | null
          bundle: Json | null
          channel_id: string | null
          created_at: string | null
          description: string | null
          episode_id: string | null
          made_for_kids: boolean | null
          marked_scheduled_at: string | null
          platform: string | null
          publication_id: string | null
          scheduled_for: string | null
          series: string | null
          slot_date: string | null
          slot_id: string | null
          status: string | null
          tags: string[] | null
          title: string | null
          topic: string | null
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
            foreignKeyName: "publications_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publications_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_episode_spend"
            referencedColumns: ["episode_id"]
          },
          {
            foreignKeyName: "publications_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["episode_id"]
          },
          {
            foreignKeyName: "publications_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publications_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "v_slot_status"
            referencedColumns: ["id"]
          },
        ]
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
      v_recipe_performance: {
        Row: {
          driver: string | null
          has_shipped_evidence: boolean | null
          is_active: boolean | null
          last_compiled_at: string | null
          median_retention_3s_pct: number | null
          model: string | null
          name: string | null
          prompt_id: string | null
          ship_rate: number | null
          times_compiled: number | null
          times_shipped: number | null
          videos_measured: number | null
          videos_with_retention: number | null
        }
        Relationships: []
      }
      v_referral_attribution: {
        Row: {
          accounts_connected: number | null
          accounts_verified: number | null
          driver: string | null
          period: string | null
          referral_source: string | null
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "renders_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
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
      v_script_structure_novelty: {
        Row: {
          script_id: string | null
          shared_script_ids: string[] | null
          shared_with: number | null
          structure_hash: string | null
          unmeasured: boolean | null
        }
        Relationships: []
      }
      v_script_vo_status: {
        Row: {
          characters_billed: number | null
          concept_id: string | null
          cost_inr: number | null
          script_id: string | null
          shots: number | null
          shots_timed: number | null
          takes: number | null
          total_duration_s: number | null
          unbilled_takes: number | null
          unmeasured_takes: number | null
          unstitched_takes: number | null
          vo_chars: number | null
          vo_state: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scripts_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["concept_id"]
          },
        ]
      }
      v_slot_status: {
        Row: {
          brief_id: string | null
          brief_status: string | null
          channel_id: string | null
          created_at: string | null
          episode: string | null
          episode_id: string | null
          episode_status: string | null
          flagged: boolean | null
          hook: string | null
          id: string | null
          kind: string | null
          lead: string | null
          notes: string | null
          production_status: string | null
          publish_at: string | null
          seasonal_tag: string | null
          series: string | null
          series_name: string | null
          slot_date: string | null
          topic: string | null
          topic_status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "slots_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stuck_submits: {
        Row: {
          charged: boolean | null
          driver: string | null
          id: string | null
          idempotency_key: string | null
          model: string | null
          shot_id: string | null
          stuck_for: string | null
          submitted_at: string | null
        }
        Insert: {
          charged?: never
          driver?: string | null
          id?: string | null
          idempotency_key?: string | null
          model?: string | null
          shot_id?: string | null
          stuck_for?: never
          submitted_at?: string | null
        }
        Update: {
          charged?: never
          driver?: string | null
          id?: string | null
          idempotency_key?: string | null
          model?: string | null
          shot_id?: string | null
          stuck_for?: never
          submitted_at?: string | null
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
            referencedRelation: "v_unresolved_shots"
            referencedColumns: ["shot_id"]
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "studio_sessions_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
            referencedColumns: ["script_id"]
          },
        ]
      }
      v_tracked_channel_health: {
        Row: {
          baseline_computed_at: string | null
          baseline_median_views: number | null
          baseline_video_count: number | null
          blocker: string | null
          is_active: boolean | null
          last_error: string | null
          last_polled_at: string | null
          niche: string | null
          poll_failures: number | null
          title: string | null
          tracked_channel_id: string | null
          videos_known: number | null
          videos_scored: number | null
        }
        Insert: {
          baseline_computed_at?: string | null
          baseline_median_views?: number | null
          baseline_video_count?: number | null
          blocker?: never
          is_active?: boolean | null
          last_error?: string | null
          last_polled_at?: string | null
          niche?: string | null
          poll_failures?: number | null
          title?: string | null
          tracked_channel_id?: string | null
          videos_known?: never
          videos_scored?: never
        }
        Update: {
          baseline_computed_at?: string | null
          baseline_median_views?: number | null
          baseline_video_count?: number | null
          blocker?: never
          is_active?: boolean | null
          last_error?: string | null
          last_polled_at?: string | null
          niche?: string | null
          poll_failures?: number | null
          title?: string | null
          tracked_channel_id?: string | null
          videos_known?: never
          videos_scored?: never
        }
        Relationships: []
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
            referencedRelation: "v_cost_per_1k_views"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_hook_unclassified"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["script_id"]
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
            referencedRelation: "v_script_structure_novelty"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_script_vo_status"
            referencedColumns: ["script_id"]
          },
          {
            foreignKeyName: "shots_script_id_fkey"
            columns: ["script_id"]
            isOneToOne: false
            referencedRelation: "v_video_cost"
            referencedColumns: ["script_id"]
          },
        ]
      }
      v_variation_ledger: {
        Row: {
          brief_id: string | null
          catchphrase_used: string | null
          channel_id: string | null
          created_at: string | null
          desk: string | null
          ending_type: string | null
          hook_archetype: string | null
          lead: string | null
          music_bed: string | null
          on_date: string | null
          premise_type: string | null
          series: string | null
          status: string | null
          structure_variant: string | null
        }
        Relationships: [
          {
            foreignKeyName: "briefs_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
        ]
      }
      v_video_cost: {
        Row: {
          channel_id: string | null
          committed_inr: number | null
          component_inr: Json | null
          concept_id: string | null
          created_at: string | null
          denominator_state: string | null
          estimated_inr: number | null
          ledger_rows: number | null
          measured_inr: number | null
          measured_rows: number | null
          publications_live: number | null
          renders: number | null
          renders_ready: number | null
          script_id: string | null
          title: string | null
          unpriced_committed_rows: number | null
          unpriced_incurred_rows: number | null
        }
        Relationships: [
          {
            foreignKeyName: "concepts_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "concepts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scripts_concept_id_fkey"
            columns: ["concept_id"]
            isOneToOne: false
            referencedRelation: "v_pipeline_blockers"
            referencedColumns: ["concept_id"]
          },
        ]
      }
    }
    Functions: {
      approve_pilot_once: {
        Args: {
          p_approved_by?: string
          p_generation_id: string
          p_script_id: string
        }
        Returns: boolean
      }
      assert_vault_available: { Args: never; Returns: undefined }
      brief_similarity: {
        Args: {
          p_channel: string
          p_embedding: string
          p_exclude: string
          p_window: number
        }
        Returns: {
          brief_id: string
          similarity: number
        }[]
      }
      bureau_brief_approve: {
        Args: {
          p_brief: string
          p_choice: string
          p_edits: Json
          p_punchline: string
          p_token: string
        }
        Returns: string
      }
      bureau_brief_reject: {
        Args: { p_brief: string; p_reason: string; p_token: string }
        Returns: undefined
      }
      bureau_caps_set: {
        Args: { p_changes: Json; p_token: string }
        Returns: {
          caption_scale: number
          catchphrase_weekly_max: number
          channel_id: string
          character_beat_max_s: number
          daily_cap_inr: number
          daily_longform_cap_inr: number
          daily_publish_cap: number
          default_slot_time: string
          gate2_passed_at: string | null
          hook_archetype_weekly_max: number
          hook_s: number
          hook_scale: number
          instagram_publish_enabled: boolean
          kill_switch: boolean
          kill_switch_at: string | null
          kill_switch_reason: string | null
          line_gap_s: number
          loudness_target_lufs: number
          made_for_kids_default: boolean
          max_pictures_per_shot: number
          money_shot_max: number
          monthly_cap_after_gate2_inr: number
          monthly_cap_inr: number
          overlay_min_share: number
          per_short_cap_inr: number
          relevance_threshold: number
          rerolls_max: number
          seconds_per_picture: number
          similarity_max: number
          similarity_window: number
          slot_timezone: string
          stills_enabled: boolean
          synthetic_disclosure: string
          tail_s: number
          updated_at: string
          updated_by: string | null
          variation_min_axes: number
          variation_window: number
          voice_overflow: boolean
          youtube_api_audited: boolean
        }
        SetofOptions: {
          from: "*"
          to: "channel_policy"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      bureau_cut_decide: {
        Args: {
          p_approve: boolean
          p_episode: string
          p_note: string
          p_token: string
        }
        Returns: Json
      }
      bureau_kill_switch: {
        Args: { p_on: boolean; p_reason: string; p_token: string }
        Returns: {
          caption_scale: number
          catchphrase_weekly_max: number
          channel_id: string
          character_beat_max_s: number
          daily_cap_inr: number
          daily_longform_cap_inr: number
          daily_publish_cap: number
          default_slot_time: string
          gate2_passed_at: string | null
          hook_archetype_weekly_max: number
          hook_s: number
          hook_scale: number
          instagram_publish_enabled: boolean
          kill_switch: boolean
          kill_switch_at: string | null
          kill_switch_reason: string | null
          line_gap_s: number
          loudness_target_lufs: number
          made_for_kids_default: boolean
          max_pictures_per_shot: number
          money_shot_max: number
          monthly_cap_after_gate2_inr: number
          monthly_cap_inr: number
          overlay_min_share: number
          per_short_cap_inr: number
          relevance_threshold: number
          rerolls_max: number
          seconds_per_picture: number
          similarity_max: number
          similarity_window: number
          slot_timezone: string
          stills_enabled: boolean
          synthetic_disclosure: string
          tail_s: number
          updated_at: string
          updated_by: string | null
          variation_min_axes: number
          variation_window: number
          voice_overflow: boolean
          youtube_api_audited: boolean
        }
        SetofOptions: {
          from: "*"
          to: "channel_policy"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      bureau_mark_scheduled: {
        Args: { p_at: string; p_publication: string; p_token: string }
        Returns: {
          altered_content_disclosed: boolean
          bundle: Json | null
          channel_id: string
          created_at: string
          description: string | null
          episode_id: string | null
          error_detail: string | null
          external_post_id: string | null
          external_url: string | null
          id: string
          idempotency_key: string | null
          made_for_kids: boolean
          marked_scheduled_at: string | null
          platform: string
          published_at: string | null
          render_id: string
          review_id: string
          scheduled_for: string | null
          slot_id: string | null
          status: string
          tags: string[] | null
          thumbnail_asset_id: string | null
          title: string
          upload_attempts: number
          upload_bytes_sent: number | null
          upload_session_url: string | null
          upload_started_at: string | null
          upload_total_bytes: number | null
        }
        SetofOptions: {
          from: "*"
          to: "publications"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      bureau_require_scope: {
        Args: { p_scope: string; p_token: string }
        Returns: {
          channel_id: string
          created_at: string
          expires_at: string | null
          id: string
          kind: string
          last_used_at: string | null
          name: string
          oauth_client_id: string | null
          oauth_redirect_uri: string | null
          profile_id: string | null
          revoked_at: string | null
          scope: string
          token_hash: string
          token_prefix: string
        }
        SetofOptions: {
          from: "*"
          to: "mcp_tokens"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      channel_killed: { Args: { p_channel: string }; Returns: boolean }
      claim_gen_jobs: {
        Args: { p_max: number; p_provider: string; p_worker: string }
        Returns: {
          attempts: number
          created_at: string
          duration_s: number
          endpoint: string | null
          episode_id: string | null
          estimate_inr: number | null
          failover_of: string | null
          generation_id: string | null
          id: string
          idempotency_key: string
          last_error: string | null
          last_error_code: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          model: string
          next_attempt_at: string
          note: string | null
          params: Json
          poll_ref: Json
          prompt_id: string | null
          provider: string
          render_route: string
          request_id: string | null
          reroll_index: number
          reroll_of: string | null
          shot_id: string | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "gen_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
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
      reorder_shots: {
        Args: { p_script_id: string; p_shot_ids: string[] }
        Returns: number
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
