# Cargo Pulse

轻量物流跟进系统，采用 GitHub → Vercel + Supabase 的云端架构。

## AI 只读数据 API

生产地址为 https://kis.net/rest/v1/ai/ 。API 提供订单（含回收站记录）、物流节点、分批发货及其节点、工厂进度、异常记录、图片元数据、合作方与内部资料表。账号、邀请设置、会话和图片文件本体不在这些数据集中。订单响应可能包含客户联系资料，应仅将密钥配置到授权读取这些数据的 AI 工具。

### 创建密钥

以下 PowerShell 命令使用主管账号登录并创建一个有效期为 30 天的密钥。密码通过交互提示输入。

```powershell
$credential = Get-Credential -Message '登录 Cargo Pulse 主管账号'
$body = @{
  email = $credential.UserName
  password = $credential.GetNetworkCredential().Password
} | ConvertTo-Json
$session = Invoke-RestMethod -Method Post -Uri 'https://kis.net/auth/v1/token?grant_type=password' -ContentType 'application/json' -Body $body
$supervisorHeaders = @{ Authorization = "Bearer $($session.access_token)" }
$issued = Invoke-RestMethod -Method Post -Uri 'https://kis.net/rest/v1/ai/keys' -Headers $supervisorHeaders
$issued.key
```

每个 AI 工具可使用独立密钥。密钥只在创建响应中返回，将其保存在 AI 工具的秘密变量或凭据配置里。

### 读取和撤销

```http
GET /rest/v1/ai/datasets
Authorization: Bearer YOUR_AI_READ_KEY

GET /rest/v1/ai/orders?limit=100
Authorization: Bearer YOUR_AI_READ_KEY
```

数据响应包含 `data` 和 `next_cursor`。如游标非空，将其作为下一次请求的 `cursor` 参数并进行 URL 编码。每页默认 100 条，最大 500 条。分页按记录 ID 排序，生产数据仍可实时变化。

用主管登录令牌调用 `GET /rest/v1/ai/keys` 查看有效密钥的编号和到期日，用 `DELETE /rest/v1/ai/keys/{key_id}` 撤销。

## Shopify 订单同步

同步由腾讯服务器上的 cargo-pulse-data 服务运行，启动时执行一次，之后每 30 分钟执行。起始时间为新加坡时间 2026-11-21 00:00。业务员从订单页面顶部的「Shopify 待认领」进入认领和补录，提交后进入跟单可操作的「业务员已下单」状态。跟单编辑主工厂并确认已向工厂下单后，进入现有流程。

在 Shopify Dev Dashboard 创建并安装与店铺同组织的应用，授予 read_orders 及客户收货地址所需的受保护客户数据权限。将以下配置写入服务器的 /etc/cargo-pulse/local-data.env，然后重启 cargo-pulse-data 服务。用服务器的机密配置存放真实值。

```dotenv
SHOPIFY_ORDER_SHOP=inflatablezones.myshopify.com
SHOPIFY_ORDER_CLIENT_ID=YOUR_CLIENT_ID
SHOPIFY_ORDER_CLIENT_SECRET=YOUR_CLIENT_SECRET
```

服务会自动换取并续期 Shopify 令牌。已有可长期使用的 Admin API Token 也可通过 SHOPIFY_ORDER_TOKEN 配置。日志可通过 journalctl -u cargo-pulse-data 查看。
