import asyncio
from app.database import get_supabase

async def main():
    supabase = get_supabase()
    # Fetch latest completed cover letters
    res = supabase.table("cover_letters").select("id, pass_3_final, quality_flags").order("completed_at", desc=True).limit(5).execute()
    for row in res.data:
        print("="*80)
        print(f"ID: {row['id']}")
        print(f"FLAGS: {row['quality_flags']}")
        print("BODY:")
        print(row['pass_3_final'])
        print("="*80)

if __name__ == "__main__":
    asyncio.run(main())
