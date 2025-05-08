export async function GET(){
  return new Response(JSON.stringify({ message: 'world' }),{
    status:200,
    headers:{ "Content-Type": "application/json" }
  })
}
